// CORS ヘルパー — carepass.tamjump.com からのリクエストのみ許可

export function corsHeaders(env, origin) {
  // 許可されたOriginのみ反射
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim());
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] || '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function handleOptions(request, env) {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env, origin),
  });
}

export function jsonResponse(data, status, env, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env, origin || ''),
    },
  });
}
