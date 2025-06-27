const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const secretsClient = new SecretsManagerClient();

const S3_BUCKET = process.env.S3_BUCKET;
const KEY_PREFIX = '-PREFIX';
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const SECRET_ID = process.env.SECRET_ID;
const KEY_PAIR_ID = process.env.KEY_PAIR_ID;
let PRIVATE_KEY; // Will be loaded from Secrets Manager

async function getPrivateKey() {
    if (PRIVATE_KEY) return PRIVATE_KEY;
    const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    PRIVATE_KEY = JSON.parse(secret.SecretString).privateKey;
    return PRIVATE_KEY;
}

async function getSignedUrl(url, expiresInSeconds, resourcePattern, keyPairId) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;

    const policy = {
        Statement: [
            {
                Resource: resourcePattern,
                Condition: {
                    DateLessThan: { 'AWS:EpochTime': expires }
                }
            }
        ]
    };
    const policyStr = JSON.stringify(policy);
    const policyBase64 = Buffer.from(policyStr).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

    // Sign the policy
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(policyStr);
    const signature = sign.sign(await getPrivateKey(), 'base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

    // Build the signed URL
    const separator = url.includes('?') ? '&' : '?';
    return (
        url +
        separator +
        'Policy=' + policyBase64 +
        '&Signature=' + signature +
        '&Key-Pair-Id=' + keyPairId
    );
}

if (!KEY_PREFIX || !S3_BUCKET) {
    throw new Error(`Missing required environment variable/s. Required vars: [KEY_PREFIX, S3_BUCKET].`);
}

const s3 = new S3Client();

exports.handler = async (event) => {
    try {
        console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

        const s3Key = event.pathParameters.proxy;
        console.log(`Received request for S3 key: ${s3Key}`);

        const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
        const body = await streamToString(obj.Body);

        const qp = event.queryStringParameters || {};

        // Reconstruct query param URI
        let params = [];
        Object.keys(qp).forEach((p) => {
            if (p.includes(KEY_PREFIX)) {
                params.push(p.replace(KEY_PREFIX, '') + '=' + encodeURIComponent(qp[p]));
            }
        });
        const signParams = params.length ? '?' + params.join('&') : '';
        console.log(`Query parameters after processing: ${signParams}`);

        // Build the base URL for absolute references
        const protocol = event.headers['X-Forwarded-Proto'] || event.headers['x-forwarded-proto'] || 'https';
        const host = CLOUDFRONT_DOMAIN;
        const resourcePattern = `${protocol}://${host}/*`;

        // Remove the filename from the path to get the base path
        const pathParts = event.path.split('/');
        pathParts.pop(); // remove filename
        const basePath = pathParts.join('/');

        // Regex to match .ts and .m3u8 references (relative or absolute)
        const respBody = await replaceAsync(
            body,
            /([^\s"']+\.(ts|m3u8))(\?[^"'\s]*)?/g,
            async (match, filePath, ext, query) => {
                // If already absolute (starts with http), just rewrite with params for .m3u8
                if (/^https?:\/\//.test(filePath)) {
                    if (ext === 'ts') {
                        // Sign .ts files
                        const absUrl = filePath + (query || '');
                        const signedUrl = await getSignedUrl(
                            absUrl,
                            3600, // 1 hour expiry
                            resourcePattern,
                            KEY_PAIR_ID
                        );
                        return signedUrl;
                    } else {
                        // For .m3u8, just append params if needed
                        return `${filePath}${query || ''}${signParams}`;
                    }
                }
                // Otherwise, make absolute
                let absUrl = `${protocol}://${host}${filePath.startsWith('/') ? '' : basePath + '/'}${filePath}${query || ''}`;
                if (ext === 'ts') {
                    // Sign .ts files
                    const signedUrl = await getSignedUrl(
                        absUrl,
                        3600, // 1 hour expiry
                        resourcePattern,
                        KEY_PAIR_ID
                    );
                    return signedUrl;
                } else {
                    // For .m3u8, just append params if needed
                    return `${absUrl}${signParams}`;
                }
            }
        );
        console.log(`Response body: ${respBody}`);

        return {
            statusCode: 200,
            body: respBody,
        };
    } catch (e) {
        console.error(e);
        return { statusCode: 500, body: '' };
    }
};

// Helper for async replace
async function replaceAsync(str, regex, asyncFn) {
    const promises = [];
    str.replace(regex, (match, ...args) => {
        const promise = asyncFn(match, ...args);
        promises.push(promise);
        return match;
    });
    const data = await Promise.all(promises);
    let i = 0;
    return str.replace(regex, () => data[i++]);
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        stream.on('error', reject);
    });
}