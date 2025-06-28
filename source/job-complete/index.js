const { writeManifest, processJobDetails, sendMetrics, sendSns } = require('./lib/utils.js');
const { request } = require('https');
const { SecretsManager, DynamoDB } = require('aws-sdk');

const secretsManager = new SecretsManager();
const dynamodb = new DynamoDB.DocumentClient();

const GET_SIGNED_URL_API = process.env.GET_SIGNED_URL_API; // e.g. https://your-api.execute-api.us-east-1.amazonaws.com/prod/get-signed-url
const SECRET_ID = process.env.SECRET_ID; // Secret containing clientId and clientSecret

async function getClientCredentials() {
    const secret = await secretsManager.getSecretValue({ SecretId: SECRET_ID }).promise();
    const { clientId, clientSecret } = JSON.parse(secret.SecretString);
    return { clientId, clientSecret };
}

async function getSignedUrlApi(url) {
    const { clientId, clientSecret } = await getClientCredentials();
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ url });
        const req = request(
            GET_SIGNED_URL_API,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-client-id': clientId,
                    'x-client-secret': clientSecret
                }
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        resolve(parsed.signedUrl || url);
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

exports.handler = async function(event) {
    //console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    const {
        MEDIACONVERT_ENDPOINT,
        CLOUDFRONT_DOMAIN,
        SNS_TOPIC_ARN,
        SOURCE_BUCKET,
        JOB_MANIFEST,
        STACKNAME,
        METRICS,
        SOLUTION_ID,
        VERSION,
        UUID
    } = process.env;

    try {
        const status = event.detail.status;

        switch (status) {
            case 'INPUT_INFORMATION':
                try {
                    await writeManifest(SOURCE_BUCKET, JOB_MANIFEST, event);
                } catch (err) {
                    throw err;
                }
                break;
            case 'COMPLETE':
                try {
                    const jobDetails = await processJobDetails(MEDIACONVERT_ENDPOINT, CLOUDFRONT_DOMAIN, event);

                    // Update the master manifest file in s3
                    const results = await writeManifest(SOURCE_BUCKET, JOB_MANIFEST, jobDetails);

                    // Extract user metadata from the event if present
                    const userMetadata = event.detail.userMetadata || {};
                    const author = userMetadata.Author || '';
                    const description = userMetadata.Description || '';
                    const shortDescription = userMetadata.ShortDescription || '';
                    const title = userMetadata.Title || '';
                    const guid = userMetadata.Guid || '';

                    const inputFile =
                        (jobDetails.Job && jobDetails.Job.Settings && jobDetails.Job.Settings.Inputs &&
                        jobDetails.Job.Settings.Inputs[0] && jobDetails.Job.Settings.Inputs[0].FileInput)
                        || '';
                    //console.log('Input file:', inputFile);

                    //console.log(`guid: ${guid}`);

                    let HLS_GROUP = jobDetails.Outputs.HLS_GROUP || [];
                    let THUMB_NAILS = jobDetails.Outputs.THUMB_NAILS || [];

                    // Sign HLS_GROUP and THUMB_NAILS URLs
                    if (HLS_GROUP && Array.isArray(HLS_GROUP)) {
                        for (let i = 0; i < HLS_GROUP.length; i++) {
                            if (HLS_GROUP[i]) {
                                HLS_GROUP[i] = await getSignedUrlApi(HLS_GROUP[i]);
                            }
                        }
                    }
                    if (THUMB_NAILS && Array.isArray(THUMB_NAILS)) {
                        for (let i = 0; i < THUMB_NAILS.length; i++) {
                            if (THUMB_NAILS[i]) {
                                THUMB_NAILS[i] = await getSignedUrlApi(THUMB_NAILS[i]);
                            }
                        }
                    }

                    //console.log(`HLS_GROUP: ${JSON.stringify(HLS_GROUP, null, 2)}`);
                    //console.log(`THUMB_NAILS: ${JSON.stringify(THUMB_NAILS, null, 2)}`);

                    // Attach metadata to results
                    results.author = author;
                    results.description = description;
                    results.shortDescription = shortDescription;
                    results.title = title;
                    results.guid = guid;

                    // Write to DynamoDB
                    const item = {
                        guid,
                        inputFile,
                        title,
                        author,
                        description,
                        shortDescription,
                        hlsGroup: HLS_GROUP,
                        thumbnails: THUMB_NAILS,
                        createdAt: new Date().toISOString()
                    };
                    await dynamodb.put({
                        TableName: 'YogiflixMedia',
                        Item: item
                    }).promise();

                    //console.log(`DynamoDB item written: ${JSON.stringify(item, null, 2)}`);

                    if (METRICS === 'Yes') {
                        await sendMetrics(SOLUTION_ID, VERSION, UUID, results);
                    }
                    //console.log(`RESULT:: ${JSON.stringify(results, null, 2)}`);
                    //await sendSns(SNS_TOPIC_ARN, STACKNAME, status, results);
                } catch (err) {
                    throw err;
                }
                break;
            case 'CANCELED':
            case 'ERROR':
                try {
                    await sendSns(SNS_TOPIC_ARN, STACKNAME, status, event);
                } catch (err) {
                    throw err;
                }
                break;
            default:
                throw new Error('Unknow job status');
        }
    } catch (err) {
        await sendSns(SNS_TOPIC_ARN, STACKNAME, 'PROCESSING ERROR', err);
        throw err;
    }
    return;
}