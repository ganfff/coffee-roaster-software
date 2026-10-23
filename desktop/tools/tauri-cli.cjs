// Use the CLI API: its bin-name detection rejects our bundled ai-node-*.exe.
const cli = require('@tauri-apps/cli');
cli.run(process.argv.slice(2), 'RoasterDesktop').catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
