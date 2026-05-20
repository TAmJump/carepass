// CORS ヘルパー — carepass.tamjump.com からのリクエストのみ許可
// セッションクッキーを送受信するため credentials: include に対応

export function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  // credentials を許可する場合、Allow-Origin はワイルドカード不可。
  // origin が allowed に含まれていなければ最初の allowed (本番URL) にフォールバック。
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || 'https://carepass.tamjump.com');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE, OPTIONS',
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

export function jsonResponse(data, status, env, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env, origin || ''),
      ...extraHeaders,
    },
  });
}

// 302 リダイレクト用（マジックリンク verify からの遷移）
export function redirectResponse(url, env, origin, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': url,
      ...corsHeaders(env, origin || ''),
      ...extraHeaders,
    },
  });
}
