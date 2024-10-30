import http.server
import socketserver
import os
import sys

PORT = 8000
Handler = http.server.SimpleHTTPRequestHandler

# Change to webapp directory
webapp_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "webapp"
)
os.chdir(webapp_dir)

print(f"Starting server at http://localhost:{PORT}")
print("Press Ctrl+C to stop")

try:
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()
except OSError as e:
    if e.errno == 48:  # Address already in use
        print(f"Error: Port {PORT} is already in use.")
        print("Please stop any running servers or try a different port.")
        sys.exit(1)
    else:
        raise
except KeyboardInterrupt:
    print("\nServer stopped.")
