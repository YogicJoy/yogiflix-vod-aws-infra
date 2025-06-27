const crypto = require('crypto');

function getSignedUrl(url, privateKey, expiresInSeconds, resourcePattern, keyPairId) {
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

    console.log(`POLICY:: ${JSON.stringify(policy, null, 2)}`);

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
        '&Key-Pair-Id=' + keyPairId +
        '&Policy-PREFIX=' + policyBase64 +
        '&Signature-PREFIX=' + signature +
        '&Key-Pair-Id-PREFIX=' + keyPairId
    );
}
module.exports = { getSignedUrl };