const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { getSignedUrl } = require('./lib/signer');

const secretsClient = new SecretsManagerClient();

exports.handler = async (event) => {
    //console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);
    // Parse request body
    let body;

    try {
        body = JSON.parse(event.body || '{}');
        //console.log(`Parsed body: ${JSON.stringify(body)}`);
    } catch {
        return { statusCode: 400, body: 'Invalid JSON' };
    }

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

    // Validate input
    const { url } = body;
    if (!url) {
        return { statusCode: 400, body: 'Missing url parameter' };
    }

    const TEN_YEARS_IN_SECONDS = 10 * 365 * 24 * 60 * 60; // 315360000

    // Sign the URL
    const signedUrl = getSignedUrl(
        url,
        privateKey,
        TEN_YEARS_IN_SECONDS,
        process.env.RESOURCE_PATTERN,
        process.env.KEY_PAIR_ID
    );
    //console.log(`Generated signed URL: ${signedUrl}`);
    return {
        statusCode: 200,
        body: JSON.stringify({ signedUrl }),
        headers: { 'Content-Type': 'application/json' }
    };
};