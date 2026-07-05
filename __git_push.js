// Run git commands
const { execSync } = require('child_process');
const cwd = 'E:\\A\\github\\katabump';
try {
  const add = execSync('git add xserver_game_renew.py .github\\workflows\\xserver.yml xserver_renew_qinglong.py', { cwd, shell: 'cmd.exe', encoding: 'utf-8' });
  console.log('add:', add);
  const status = execSync('git status', { cwd, shell: 'cmd.exe', encoding: 'utf-8' });
  console.log(status);
} catch(e) {
  console.error(e.message);
  console.error(e.stdout);
  console.error(e.stderr);
}
