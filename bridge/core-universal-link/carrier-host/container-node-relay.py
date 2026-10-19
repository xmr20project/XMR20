"""Private loopback-only carrier-container to host SSH-tunnel TCP relay.

Creates only the listening socket in the named container's network namespace,
then returns to the host namespace and permanently drops root before serving.
No wallet files, configuration, request bodies, or credentials are read/logged.
"""
import ctypes, json, os, pwd, select, socket, subprocess, threading, time
from pathlib import Path

CONTAINER = 'xmr20-mainnet-probe-wallet'
ENDPOINT = ('127.0.0.1', 18082)
LIMIT = threading.BoundedSemaphore(8)


def process_start(pid):
    return Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()[19]


def listen_in_container(pid):
    libc = ctypes.CDLL(None, use_errno=True)
    host = os.open('/proc/self/ns/net', os.O_RDONLY)
    target = os.open('/proc/%d/ns/net' % pid, os.O_RDONLY)
    listener = None
    def enter(fd):
        if libc.setns(fd, 0x40000000) != 0:
            raise OSError(ctypes.get_errno(), 'Network namespace unavailable')
    try:
        if os.fstat(host).st_ino == os.fstat(target).st_ino:
            raise ValueError('Dedicated container namespace required')
        enter(target)
        try:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(ENDPOINT)
            listener.listen(8)
            listener.settimeout(1)
        finally:
            enter(host)
        return listener
    except BaseException:
        if listener is not None:
            listener.close()
        raise
    finally:
        os.close(target)
        os.close(host)


def relay(client, target=ENDPOINT):
    upstream = None
    try:
        upstream = socket.create_connection(target, timeout=5)
        client.settimeout(5)
        upstream.settimeout(5)
        sockets = [client, upstream]
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            ready, _, _ = select.select(sockets, [], [], 40)
            if not ready:
                break
            for source in ready:
                data = source.recv(65536)
                if not data:
                    return
                (upstream if source is client else client).sendall(data)
    except (OSError, ValueError):
        pass  # No request or exception details enter logs.
    finally:
        client.close()
        if upstream is not None:
            upstream.close()
        LIMIT.release()


def main():
    pid = int(subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Pid}}', CONTAINER], timeout=5))
    if pid <= 1:
        raise ValueError('Container unavailable')
    started = process_start(pid)
    listener = listen_in_container(pid)
    account = pwd.getpwnam('nobody')
    os.setgroups([])
    os.setgid(account.pw_gid)
    os.setuid(account.pw_uid)
    if os.getuid() == 0:
        raise ValueError('Privilege drop required')
    print(json.dumps({'event': 'private-node-relay-ready', 'loopbackOnly': True, 'unprivileged': True}), flush=True)
    try:
        while process_start(pid) == started:
            try:
                client, peer = listener.accept()
            except socket.timeout:
                continue
            if peer[0] != '127.0.0.1' or not LIMIT.acquire(blocking=False):
                client.close()
                continue
            threading.Thread(target=relay, args=(client,), daemon=True).start()
    finally:
        listener.close()


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('{"event":"private-node-relay-stopped"}', flush=True)
        raise SystemExit(1)
