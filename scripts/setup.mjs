// T124: the logic lives in apps/host/setup.ts so the menu bar app's first run uses the same code.
const args = process.argv.slice(2);
let address = '127.0.0.1', port;
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--address') address = args[i + 1];
  else if (args[i] === '--port') port = Number(args[i + 1]);
  else throw new Error('Usage: npm run setup -- [--address PRIVATE_IPV4] [--port 8940]');
}
let setup;
try { setup = await import('../dist/apps/host/setup.js'); }
catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new Error('Keyln is not built yet. Run npm run build first.');
  throw error;
}
// The port is not probed here: the Host reports a busy port itself when it starts, and the tests run several setups at once.
const result = await setup.runSetup({ address, port, checkPort: false });
console.log(`Setup ready for ${result.origin}\nPublic trust certificate: ${result.caPath}\nCopy only rootCA.pem to Surface and trust it before connecting. Keep all .key files private on this Mac.\nStart with: npm start\nSHA-256 Fingerprint=${result.caFingerprint}`);
