#!/usr/bin/env node
// Bọc lệnh `codewhale exec` cho phiên thực hiện DeepSeek:
// - Chạy trong thư mục làm việc (--cwd) bằng cwd của tiến trình con (codewhale cũng có cờ toàn cục -C đặt trước exec).
// - Đọc lời nhắc từ tệp (--prompt-file) hoặc chuỗi (--prompt), đặt mọi cờ trước `--` và lời nhắc sau `--`.
// - Nếu tệp lời nhắc dài quá ngưỡng dòng lệnh (24.000 ký tự), tự truyền lời nhắc dặn đọc tệp đó.
// - Phân loại kết quả: ok (mã thoát 0), quota_or_balance (402/429, mã thoát 3), other_error (mã thoát 1).
// - Tuyệt đối không nhận khóa API qua dòng lệnh và tự che mẫu khóa nếu xuất hiện trong đầu ra.
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_INLINE_CHARS = 24000;
const DEFAULT_TIMEOUT_MS = 600000;
const ALLOWED_SANDBOX = new Set(['workspace-write', 'read-only', 'danger-full-access']);
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const QUOTA_RE = /\b(?:status(?:\s+code)?|http|error|code)[\s:=]+(?:402|429)\b|insufficient[\s_-]*balance|insufficient[\s_-]*quota|rate[\s_-]*limit|too many requests|quota exceeded|usage limit|resource exhausted/i;

export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '<REDACTED:api-key>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<REDACTED:bearer-token>');
}

export function classifyDeepseekResult({ code, stdout = '', stderr = '', timedOut = false }) {
  if (timedOut) return 'other_error';
  if (code === 0) return 'ok';
  const combined = `${stdout}\n${stderr}`;
  if (QUOTA_RE.test(combined)) return 'quota_or_balance';
  return 'other_error';
}

function isFile(filepath) {
  try { return statSync(filepath).isFile(); } catch { return false; }
}

export function resolveCodewhale(env = process.env) {
  const rawPath = env.PATH ?? env.Path ?? '';
  const dirs = rawPath.split(delimiter).map(item => item.trim()).filter(Boolean);
  for (const dir of dirs) {
    const npmEntry = join(dir, 'node_modules', 'codewhale', 'bin', 'codewhale.js');
    if (isFile(npmEntry)) return { command: process.execPath, prefixArgs: [npmEntry] };
    if (process.platform === 'win32') {
      const exe = join(dir, 'codewhale.exe');
      if (isFile(exe)) return { command: exe, prefixArgs: [] };
      const script = join(dir, 'codewhale');
      if (isFile(script)) {
        try {
          const head = readFileSync(script, 'utf8').slice(0, 120);
          if (head.startsWith('#!') && head.includes('node')) return { command: process.execPath, prefixArgs: [script] };
        } catch { /* Bỏ qua nếu không đọc được tệp. */ }
      }
      for (const ext of ['codewhale.cmd', 'codewhale.bat']) {
        const batch = join(dir, ext);
        if (isFile(batch)) return { command: env.ComSpec || 'cmd.exe', prefixArgs: ['/d', '/s', '/c', batch] };
      }
    } else {
      const bin = join(dir, 'codewhale');
      if (isFile(bin)) return { command: bin, prefixArgs: [] };
    }
  }
  return null;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.some(arg => /^--(?:api[-_]?key|key|token|secret)(?:=|$)/i.test(arg))) {
    console.error('Không hỗ trợ truyền khóa API qua tham số dòng lệnh; hãy dùng kho bí mật hoặc biến môi trường của Codewhale.');
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rawArgs,
      strict: true,
      options: {
        cwd: { type: 'string' },
        'prompt-file': { type: 'string' },
        prompt: { type: 'string' },
        auto: { type: 'boolean' },
        sandbox: { type: 'string' },
        model: { type: 'string' },
        timeout: { type: 'string' },
      },
    }));
  } catch {
    console.error('Tham số không hợp lệ: chỉ hỗ trợ --cwd, --prompt-file, --prompt, --auto, --sandbox, --model, --timeout; không được dùng một cờ thay cho giá trị.');
    return 2;
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  try {
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    console.error(`Thư mục làm việc không tồn tại hoặc không hợp lệ: ${cwd}`);
    return 2;
  }

  const hasFile = values['prompt-file'] !== undefined;
  const hasInline = values.prompt !== undefined;
  if (hasFile === hasInline) {
    console.error('Phải truyền đúng một trong hai tùy chọn: --prompt-file <tệp> hoặc --prompt <nội dung>.');
    return 2;
  }

  let promptArg;
  if (hasFile) {
    const promptPath = resolve(cwd, values['prompt-file']);
    let content;
    try {
      content = readFileSync(promptPath, 'utf8');
    } catch {
      console.error(`Không đọc được tệp lời nhắc: ${promptPath}`);
      return 2;
    }
    if (!content.trim()) {
      console.error('Nội dung tệp lời nhắc không được rỗng.');
      return 2;
    }
    promptArg = content.length > MAX_INLINE_CHARS
      ? `Đọc tệp ${promptPath} và làm theo đúng từng chữ.`
      : content;
  } else {
    if (!values.prompt.trim()) {
      console.error('Nội dung --prompt không được rỗng.');
      return 2;
    }
    if (values.prompt.length > MAX_INLINE_CHARS) {
      console.error(`Lời nhắc dài ${values.prompt.length} ký tự, vượt giới hạn ${MAX_INLINE_CHARS}. Hãy ghi vào tệp và dùng --prompt-file.`);
      return 2;
    }
    promptArg = values.prompt;
  }

  if (values.sandbox !== undefined && !ALLOWED_SANDBOX.has(values.sandbox)) {
    console.error(`Giá trị --sandbox không hợp lệ: ${values.sandbox}. Chỉ hỗ trợ: ${[...ALLOWED_SANDBOX].join(', ')}.`);
    return 2;
  }

  if (values.model !== undefined && !MODEL_RE.test(values.model)) {
    console.error('Giá trị --model không hợp lệ.');
    return 2;
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (values.timeout !== undefined) {
    const parsed = Number(values.timeout);
    if (!Number.isInteger(parsed) || parsed < 100 || parsed > 3600000) {
      console.error('Tham số --timeout phải là số nguyên từ 100 đến 3600000 (mili-giây).');
      return 2;
    }
    timeoutMs = parsed;
  }

  const resolved = resolveCodewhale(process.env);
  if (!resolved) {
    console.log(JSON.stringify({
      status: 'other_error',
      exit_code: null,
      timed_out: false,
      model: values.model ?? 'deepseek-flash',
      cwd,
      stdout: '',
      stderr: 'Không tìm thấy lệnh codewhale trên PATH. Hãy cài đặt Codewhale (npm i -g codewhale) hoặc kiểm tra lại biến môi trường PATH.',
    }));
    return 1;
  }

  const execArgs = ['exec'];
  if (values.auto) execArgs.push('--auto');
  if (values.sandbox) execArgs.push('--sandbox', values.sandbox);
  if (values.model) execArgs.push('--model', values.model);
  execArgs.push('--', promptArg);

  const env = { ...process.env, CODEWHALE_NO_UPDATE_CHECK: '1' };
  const outcome = await new Promise(resolveRun => {
    const child = spawn(resolved.command, [...resolved.prefixArgs, ...execArgs], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, timedOut });
    });
  });

  const cleanStdout = redactSecrets(outcome.stdout.trim());
  const cleanStderr = redactSecrets(
    outcome.timedOut
      ? `${outcome.stderr.trim()}\nQuá thời gian chờ (${timeoutMs} ms).`.trim()
      : outcome.stderr.trim(),
  );
  const status = classifyDeepseekResult({
    code: outcome.code,
    stdout: cleanStdout,
    stderr: cleanStderr,
    timedOut: outcome.timedOut,
  });

  console.log(JSON.stringify({
    status,
    exit_code: outcome.code,
    timed_out: outcome.timedOut,
    model: values.model ?? 'deepseek-flash',
    cwd,
    stdout: cleanStdout,
    stderr: cleanStderr,
  }));

  if (status === 'ok') return 0;
  if (status === 'quota_or_balance') return 3;
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`Không chạy được deepseek-exec: ${redactSecrets(error?.message ?? 'Lỗi không xác định')}`);
    process.exitCode = 1;
  }
}
