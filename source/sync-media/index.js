const AWS = require('aws-sdk');
const s3 = new AWS.S3();

const DESTINATION_BUCKET = process.env.DESTINATION_BUCKET;

/*
This Lambda is triggered by a DynamoDB Streams event (REMOVE).
It deletes all objects in the S3 folder whose name matches the deleted item's guid.
*/

exports.handler = async (event) => {
    //console.log('Received DynamoDB event:', JSON.stringify(event, null, 2));
    for (const record of event.Records) {
        if (record.eventName !== 'REMOVE') continue;

        // Get guid from the deleted item
        const guid = record.dynamodb.Keys.guid.S || record.dynamodb.OldImage.guid.S;
        //console.log(`Processing deleted guid: ${guid}`);

        // List all objects in the S3 folder (prefix = guid + '/')
        const listParams = {
            Bucket: DESTINATION_BUCKET,
            Prefix: `${guid}/`
        };

        try {
            let listedObjects;
            do {
                listedObjects = await s3.listObjectsV2(listParams).promise();
                if (!listedObjects.Contents || listedObjects.Contents.length === 0) break;

                const deleteParams = {
                    Bucket: DESTINATION_BUCKET,
                    Delete: {
                        Objects: listedObjects.Contents.map(obj => ({ Key: obj.Key }))
                    }
                };

                await s3.deleteObjects(deleteParams).promise();
                //console.log(`Deleted objects for guid: ${guid}`, deleteParams.Delete.Objects);

                // If there are more objects, continue
                listParams.ContinuationToken = listedObjects.NextContinuationToken;
            } while (listedObjects.IsTruncated);

        } catch (err) {
            console.error(`Failed to delete S3 objects for guid ${guid}:`, err);
        }
    }
    return;
};