"""Framing and sniffing protection for every response (the SPA, the API and file downloads)."""


class SecurityHeadersMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        response.headers.setdefault('X-Frame-Options', 'DENY')
        response.headers.setdefault('X-Content-Type-Options', 'nosniff')
        response.headers.setdefault('Referrer-Policy', 'same-origin')
        csp = response.headers.get('Content-Security-Policy')
        if not csp:
            response.headers['Content-Security-Policy'] = "frame-ancestors 'none'"
        elif 'frame-ancestors' not in csp:
            response.headers['Content-Security-Policy'] = csp + "; frame-ancestors 'none'"
        return response
