const crypto = require('crypto');

function getSignedUrl(url, privateKey, expiresInSeconds, resourcePattern, keyPairId) {
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;

    // Custom policy allows wildcards in resource if needed
    const resource = resourcePattern || url;
    const policy = {
        Statement: [
            {
                Resource: resource,
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
    const signature = sign.sign(privateKey, 'base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

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
module.exports = { getSignedUrl };