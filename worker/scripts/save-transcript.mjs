// One-off: join a live room as an observer, save its transcript, leave.
// Usage: node worker/scripts/save-transcript.mjs 'room:<id>'
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const roomId = process.argv[2];
if (!roomId?.startsWith('room:')) {
  console.error("usage: node save-transcript.mjs 'room:<id>'");
  process.exit(1);
}

const url = 'wss://duck-facilitator.aayushkggn.workers.dev/room?roomId=' + encodeURIComponent(roomId);
const ws = new WebSocket(url, { headers: { Origin: 'null' } });
const timer = setTimeout(() => { console.error('timed out'); process.exit(1); }, 10_000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'join', clientId: randomUUID(), displayName: 'Transcript saver' })));
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type === 'error') { console.error('server error:', msg); process.exit(1); }
  if (msg.type !== 'snapshot') return;
  clearTimeout(timer);
  ws.close(1000);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `transcript-${stamp}`;
  writeFileSync(base + '.json', JSON.stringify(msg, null, 2));
  const md = msg.messages
    .map((m) => `**${m.author.displayName}** (${m.kind}${m.mood ? ', ' + m.mood : ''}, ${new Date(m.at).toLocaleString()})\n\n${m.text}\n`)
    .join('\n---\n\n');
  writeFileSync(base + '.md', `# ${roomId}\n\nRound ${msg.round.id}, ${msg.participants.length} connected\n\n${md}`);
  console.log(`saved ${msg.messages.length} messages -> ${base}.md / .json`);
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
