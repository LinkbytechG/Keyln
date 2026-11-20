try {
  const {serviceCommand}=await import('../dist/apps/host/service-cli.js');
  await serviceCommand(process.argv.slice(2));
} catch(error) {
  console.error(`Keyln service: ${error.code==='ERR_MODULE_NOT_FOUND'?'Run npm run build before using service commands.':error.message}`);
  process.exitCode=1;
}
