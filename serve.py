# Serveur de test local (sans cache) : python3 serve.py
# Sert le dossier du projet sur le port 8765 et empêche le navigateur de garder
# d'anciennes versions des fichiers en mémoire pendant le développement.
import http.server
import os
import socket

PORT = 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.168.0.1', 1))
        return s.getsockname()[0]
    except OSError:
        return 'localhost'
    finally:
        s.close()


os.chdir(os.path.dirname(os.path.abspath(__file__)))
print(f'Sur ton iPhone (même Wi-Fi) : http://{local_ip()}:{PORT}')
print('Ctrl + C pour arrêter.')
http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler).serve_forever()
