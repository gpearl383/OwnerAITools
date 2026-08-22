export const config = {
  matcher: '/googlea8434566ec92998f.html',
};

export default function middleware() {
  return new Response('google-site-verification: googlea8434566ec92998f.html', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  });
}
