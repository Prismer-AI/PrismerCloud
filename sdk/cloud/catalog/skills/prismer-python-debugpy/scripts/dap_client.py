"""Bounded DAP transport for an already-authorized loopback debug session."""
import json
import time


class DapClient:
    def __init__(self, sock, timeout=5):
        self.sock = sock
        self.timeout = timeout
        self.seq = 0
        self.events = []

    def _read(self, count, deadline):
        data = bytearray()
        while len(data) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('DAP read deadline exceeded')
            self.sock.settimeout(remaining)
            chunk = self.sock.recv(count - len(data))
            if not chunk:
                raise EOFError('DAP peer closed connection')
            data.extend(chunk)
        return bytes(data)

    def receive(self, deadline=None):
        deadline = deadline or time.monotonic() + self.timeout
        header = bytearray()
        while not header.endswith(b'\r\n\r\n'):
            if len(header) >= 8192:
                raise ValueError('DAP header too large')
            header.extend(self._read(1, deadline))
        lengths = [line.split(b':', 1)[1].strip() for line in header.split(b'\r\n') if line.lower().startswith(b'content-length:')]
        if len(lengths) != 1 or not lengths[0].isdigit() or int(lengths[0]) > 4_000_000:
            raise ValueError('invalid DAP content length')
        packet = json.loads(self._read(int(lengths[0]), deadline))
        if not isinstance(packet, dict):
            raise ValueError('DAP packet must be an object')
        return packet

    def send(self, command, arguments=None):
        self.seq += 1
        body = json.dumps({'seq': self.seq, 'type': 'request', 'command': command,
                           'arguments': arguments or {}}).encode()
        self.sock.settimeout(self.timeout)
        self.sock.sendall(f'Content-Length: {len(body)}\r\n\r\n'.encode() + body)
        return self.seq

    def wait(self, predicate):
        for i, packet in enumerate(self.events):
            if predicate(packet):
                return self.events.pop(i)
        deadline = time.monotonic() + self.timeout
        while len(self.events) < 1000:
            packet = self.receive(deadline)
            if predicate(packet):
                return packet
            self.events.append(packet)
        raise ValueError('DAP event queue limit exceeded')

    def response(self, seq):
        packet = self.wait(lambda p: p.get('type') == 'response' and p.get('request_seq') == seq)
        if not packet.get('success'):
            raise RuntimeError('DAP request failed: ' + str(packet.get('message', 'unspecified')))
        return packet

    def request(self, command, arguments=None):
        return self.response(self.send(command, arguments))
