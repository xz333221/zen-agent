#!/usr/bin/env python3
"""TCP Relay: forwards 0.0.0.0:10812 -> 127.0.0.1:10811
Allows WSL2/Docker to access v2rayN proxy on Windows localhost."""

import socket
import threading
import sys
import time

LISTEN_HOST = "0.0.0.0"
LISTEN_PORT = 10812
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 10811

def relay(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle_client(client):
    try:
        target = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        target.connect((TARGET_HOST, TARGET_PORT))
        t1 = threading.Thread(target=relay, args=(client, target), daemon=True)
        t2 = threading.Thread(target=relay, args=(target, client), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    except Exception as e:
        print(f"Error: {e}")
        try: client.close()
        except: pass

def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen(128)
    print(f"TCP Relay: {LISTEN_HOST}:{LISTEN_PORT} -> {TARGET_HOST}:{TARGET_PORT}")
    sys.stdout.flush()

    while True:
        client, addr = server.accept()
        print(f"Connection from {addr[0]}:{addr[1]}")
        sys.stdout.flush()
        t = threading.Thread(target=handle_client, args=(client,), daemon=True)
        t.start()

if __name__ == "__main__":
    main()
