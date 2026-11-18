// Where NoBossly may connect on a member's behalf. A database address or
// WordPress site has to be a public host: anything that resolves to a private,
// loopback, link-local or cloud-metadata address is refused, so a pasted
// address cannot be used to reach machines inside our own network. The
// connection then goes to the address that was checked (not a fresh lookup),
// so the name cannot be switched to a private address in between.

const dns = require('dns').promises;
const net = require('net');

function privateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||      // carrier-grade NAT
    (a === 169 && b === 254) ||                // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
function privateV6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateV4(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s) || s.startsWith('64:ff9b:') || s.startsWith('2001:db8');
}
const isPrivate = ip => (net.isIPv4(ip) ? privateV4(ip) : net.isIPv6(ip) ? privateV6(ip) : true);

const cleanHost = h => String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
const hostShape = h => /^[a-z0-9]([a-z0-9-]{0,62}\.)+[a-z][a-z0-9-]{1,62}$/.test(h);

/**
 * A public address for a host name, or { error }. Bare IP addresses are
 * refused too: a real database host has a name, and a name is what TLS checks.
 */
async function resolvePublic(host, { lookup = dns.lookup } = {}) {
  const h = cleanHost(host);
  if (!h || net.isIP(h)) return { error: 'Use the host name your provider gives you, not an IP address.' };
  if (!hostShape(h) || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h)) return { error: 'That host name is not a public address.' };
  let all;
  try { all = await lookup(h, { all: true, verbatim: true }); } catch (_) { return { error: 'We could not find ' + h + '. Check the host name.' }; }
  if (!all || !all.length) return { error: 'We could not find ' + h + '. Check the host name.' };
  if (all.some(a => isPrivate(a.address))) return { error: 'That address points inside a private network, so NoBossly will not connect to it.' };
  const v4 = all.find(a => a.family === 4);
  return { host: h, address: (v4 || all[0]).address, family: (v4 || all[0]).family };
}

module.exports = { isPrivate, resolvePublic, cleanHost };
