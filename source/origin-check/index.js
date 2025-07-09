exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const allowedOrigins = [
    'https://ff-debug-service-frontend-pro-ygxkweukma-uc.a.run.app',
    'https://app.flutterflow.io',
    'https://yogiflix.com',
    'https://www.yogiflix.com',
    'https://yogicjoy.com',
    'https://www.yogicjoy.com'
  ];

  const originHeader = headers.origin && headers.origin[0] && headers.origin[0].value;
  if (originHeader && !allowedOrigins.includes(originHeader)) {
    return {
      status: '403',
      statusDescription: 'Forbidden',
      body: 'Origin not allowed',
    };
  }
  request.headers['access-control-allow-origin'] = [{ key: 'Access-Control-Allow-Origin', value: originHeader }];
  return request;
};