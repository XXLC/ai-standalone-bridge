// Kiểm thử script bọc codewhale exec bằng một lệnh codewhale giả đặt trên PATH.
// Không gọi API DeepSeek thật; mọi chuỗi khóa trong test là khóa giả được ghép lúc chạy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../src/deepseek-exec.mjs', import.meta.url));
const TEMP = mkdtempSync(fileURLToPath(new URL('../.tmp-deepseek-', import.meta.url)));
after(() => rmSync(TEMP, { recursive: true, force: true }));

const FAKE_BIN = join(TEMP, 'fake-bin');
const WORK_DIR = join(TEMP, 'workspace');
mkdirSync(FAKE_BIN, { recursive: true });
mkdirSync(WORK_DIR, { recursive: true });

const FAKE_CODEWHALE_SOURCE = `#!/usr/bin/env node
const mode = process.env.FAKE_CODEWHALE_MODE || 'ok';
const payload = {
  cwd: process.cwd(),
  args: process.argv.slice(2),
  noUpdateCheck: process.env.CODEWHALE_NO_UPDATE_CHECK,
};
if (mode === 'ok') {
  process.stdout.write(JSON.stringify(payload) + '\\n');
  process.exit(0);
}
if (mode === '402') {
  process.stderr.write('HTTP 402 Insufficient Balance: tài khoản hết số dư.\\n');
  process.exit(1);
}
if (mode === '429') {
  process.stderr.write('Error 429: rate limit reached (Too Many Requests).\\n');
  process.exit(1);
}
if (mode === 'leak') {
  const fakeKey = 'sk-' + 'test-0000abcdef123456';
  const fakeBearer = 'Bearer ' + 'tok_test_0000abcdef123456';
  process.stdout.write('ket qua co khoa ' + fakeKey + '\\n');
  process.stderr.write('loi xac thuc ' + fakeBearer + '\\n');
  process.exit(1);
}
if (mode === 'timeout') {
  setTimeout(() => process.exit(0), 10000);
} else {
  process.stderr.write('Lỗi thực thi công việc thông thường.\\n');
  process.exit(1);
}
`;

const fakeBinFile = join(FAKE_BIN, 'codewhale');
writeFileSync(fakeBinFile, FAKE_CODEWHALE_SOURCE, 'utf8');
chmodSync(fakeBinFile, 0o755);

function runExec(args, { env: extraEnv = {}, pathDir = FAKE_BIN } = {}) {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env, ...extraEnv };
    delete env.Path;
    env.PATH = pathDir === null ? '' : `${pathDir}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: TEMP, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('deepseek-exec không thoát trong 10 giây.'));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

test('chạy thành công với --cwd, --prompt-file, --auto, --sandbox, --model và đặt cờ trước --', async () => {
  const promptFile = join(WORK_DIR, 'prompt.txt');
  writeFileSync(promptFile, '- mục 1: kiểm tra lời nhắc bắt đầu bằng dấu gạch\n- mục 2: tiếng Việt có dấu', 'utf8');
  const result = await runExec([
    '--cwd', WORK_DIR,
    '--prompt-file', promptFile,
    '--auto',
    '--sandbox', 'workspace-write',
    '--model', 'deepseek-v4-pro',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.exit_code, 0);
  assert.equal(parsed.timed_out, false);
  assert.equal(parsed.model, 'deepseek-v4-pro');
  assert.equal(parsed.cwd, resolve(WORK_DIR));
  const inner = JSON.parse(parsed.stdout);
  assert.equal(inner.cwd, resolve(WORK_DIR));
  assert.equal(inner.noUpdateCheck, '1');
  assert.deepEqual(inner.args, [
    'exec',
    '--auto',
    '--sandbox', 'workspace-write',
    '--model', 'deepseek-v4-pro',
    '--',
    '- mục 1: kiểm tra lời nhắc bắt đầu bằng dấu gạch\n- mục 2: tiếng Việt có dấu',
  ]);
});

test('tệp lời nhắc vượt ngưỡng 24.000 ký tự tự động chuyển thành lời nhắc đọc tệp', async () => {
  const longFile = join(WORK_DIR, 'long-prompt.txt');
  writeFileSync(longFile, 'a'.repeat(24001), 'utf8');
  const result = await runExec(['--cwd', WORK_DIR, '--prompt-file', 'long-prompt.txt']);
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const inner = JSON.parse(parsed.stdout);
  assert.equal(inner.args.at(-2), '--');
  assert.ok(inner.args.at(-1).includes(resolve(longFile)));
  assert.match(inner.args.at(-1), /^Đọc tệp .* và làm theo đúng từng chữ\.$/);
});

test('phân loại đúng lỗi hết tiền (402) và giới hạn tốc độ (429) với mã thoát 3', async () => {
  for (const mode of ['402', '429']) {
    const result = await runExec(['--cwd', WORK_DIR, '--prompt', 'Kiểm tra quota'], {
      env: { FAKE_CODEWHALE_MODE: mode },
    });
    assert.equal(result.code, 3);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, 'quota_or_balance');
    assert.equal(parsed.exit_code, 1);
    assert.equal(parsed.timed_out, false);
    assert.match(parsed.stderr, new RegExp(mode));
  }
});

test('phân loại lỗi công việc khác, quá thời gian chờ và thiếu codewhale trên PATH với mã thoát 1', async () => {
  const taskErr = await runExec(['--cwd', WORK_DIR, '--prompt', 'Việc lỗi'], {
    env: { FAKE_CODEWHALE_MODE: 'other' },
  });
  assert.equal(taskErr.code, 1);
  assert.equal(JSON.parse(taskErr.stdout).status, 'other_error');

  const timedOut = await runExec(['--cwd', WORK_DIR, '--prompt', 'Chờ lâu', '--timeout', '150'], {
    env: { FAKE_CODEWHALE_MODE: 'timeout' },
  });
  assert.equal(timedOut.code, 1);
  const timedOutJson = JSON.parse(timedOut.stdout);
  assert.equal(timedOutJson.status, 'other_error');
  assert.equal(timedOutJson.timed_out, true);
  assert.match(timedOutJson.stderr, /Quá thời gian chờ/);

  const missingBin = await runExec(['--cwd', WORK_DIR, '--prompt', 'Thiếu lệnh'], { pathDir: null });
  assert.equal(missingBin.code, 1);
  const missingJson = JSON.parse(missingBin.stdout);
  assert.equal(missingJson.status, 'other_error');
  assert.equal(missingJson.exit_code, null);
  assert.match(missingJson.stderr, /Không tìm thấy lệnh codewhale trên PATH/);
});

test('không nhận khóa API qua dòng lệnh và tự che mẫu khóa trong đầu ra', async () => {
  const fakeKey = 'sk-' + 'test-0000abcdef123456';
  for (const args of [
    ['--api-key', fakeKey, '--prompt', 'x'],
    [`--api-key=${fakeKey}`, '--prompt', 'x'],
    ['--key', fakeKey, '--prompt', 'x'],
    ['--token', fakeKey, '--prompt', 'x'],
    ['--secret', fakeKey, '--prompt', 'x'],
  ]) {
    const rejected = await runExec(args);
    assert.equal(rejected.code, 2);
    assert.equal(rejected.stdout, '');
    assert.match(rejected.stderr, /Không hỗ trợ truyền khóa API/);
    assert.ok(!rejected.stderr.includes(fakeKey));
  }

  const leaked = await runExec(['--cwd', WORK_DIR, '--prompt', 'Kiểm tra che khóa'], {
    env: { FAKE_CODEWHALE_MODE: 'leak' },
  });
  assert.equal(leaked.code, 1);
  assert.ok(!leaked.stdout.includes('test-0000abcdef123456'));
  const parsed = JSON.parse(leaked.stdout);
  assert.match(parsed.stdout, /<REDACTED:api-key>/);
  assert.match(parsed.stderr, /Bearer <REDACTED:bearer-token>/);
});

test('tìm được codewhale theo bố cục cài đặt npm (node_modules/codewhale/bin/codewhale.js)', async () => {
  const npmRoot = join(TEMP, 'npm-global');
  const binDir = join(npmRoot, 'node_modules', 'codewhale', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'codewhale.js'), FAKE_CODEWHALE_SOURCE, 'utf8');
  const result = await runExec(['--cwd', WORK_DIR, '--prompt', 'Qua bố cục npm'], { pathDir: npmRoot });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'ok');
  assert.equal(JSON.parse(parsed.stdout).args.at(-1), 'Qua bố cục npm');
});

test('từ chối tham số thiếu hoặc sai định dạng với mã thoát 2 và thông báo tiếng Việt một dòng', async () => {
  for (const [args, pattern] of [
    [[], /Phải truyền đúng một trong hai/],
    [['--prompt', 'x', '--prompt-file', 'a.txt'], /Phải truyền đúng một trong hai/],
    [['--prompt', '   '], /không được rỗng/],
    [['--prompt', 'a'.repeat(24001)], /vượt giới hạn 24000/],
    [['--prompt-file', join(WORK_DIR, 'khong-ton-tai.txt')], /Không đọc được tệp lời nhắc/],
    [['--cwd', join(WORK_DIR, 'thu-muc-ao'), '--prompt', 'x'], /Thư mục làm việc không tồn tại/],
    [['--prompt', 'x', '--sandbox', 'khong-hop-le'], /Giá trị --sandbox không hợp lệ/],
    [['--prompt', 'x', '--model', 'model sai khoảng trắng'], /Giá trị --model không hợp lệ/],
    [['--prompt', 'x', '--timeout', '50'], /Tham số --timeout phải là số nguyên/],
    [['--prompt', 'x', '--co-la'], /Tham số không hợp lệ/],
    [['--model', '--auto', '--prompt', 'x'], /không được dùng một cờ thay cho giá trị/],
  ]) {
    const result = await runExec(args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, pattern);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  }
});
