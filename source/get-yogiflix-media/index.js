const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const secretsClient = new SecretsManagerClient();
const TABLE_NAME = process.env.MEDIA_TABLE || 'YogiflixMedia';

exports.handler = async (event) => {

    // Get client credentials from request headers
    const clientId = event.headers['x-client-id'];
    const clientSecret = event.headers['x-client-secret'];
    if (!clientId || !clientSecret) {
        return { statusCode: 401, body: 'Missing client credentials' };
    }

    // Fetch secret from Secrets Manager
    const secretId = process.env.SECRET_ID;
    const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    const { clientId: validClientId, clientSecret: validClientSecret, privateKey } = JSON.parse(secret.SecretString);

    // Authenticate client
    if (clientId !== validClientId || clientSecret !== validClientSecret) {
        return { statusCode: 403, body: 'Invalid client credentials' };
    }

    try {
        // Fetch all items from the table (no filtering)
        const data = await dynamodb.scan({ TableName: TABLE_NAME }).promise();
        return {
            statusCode: 200,
            body: JSON.stringify(data.Items),
            headers: { 'Content-Type': 'application/json' }
        };
    } catch (err) {
        console.error('Error fetching media:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal Server Error' }),
            headers: { 'Content-Type': 'application/json' }
        };
    }
};