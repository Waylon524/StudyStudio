import { parseChemicalEquation, parseChemicalFormula } from '../shared/chemical-equation.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const python = process.env.STUDY_CHEM_PYTHON || join(homedir(), '.local/share/codex-organic-chem/.venv/bin/python');
const worker = fileURLToPath(new URL('./chem-worker.py', import.meta.url));
const MAX_BODY = 200_000;
const MAX_OUTPUT = 4_000_000;

function reply(res, code, result) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(result));
}

export async function handleChemistry(req, res, url) {
  if (url.pathname !== '/api/chem/render' || req.method !== 'POST') return false;
  let size = 0, body = '';
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) { reply(res, 413, {status:'error', warnings:['Input exceeds 200 KB.']}); return true; }
      body += chunk.toString('utf8');
    }
    const data = JSON.parse(body);
    if (!data || !['molecule','reaction','mechanism','equation','formula'].includes(data.kind) || !['string','object'].includes(typeof data.source) || data.source === null) throw new Error('Provide a valid kind and source.');
    if (data.kind === 'equation') {
      if (typeof data.source !== 'string') throw new Error('Chemical equation requires formula text.');
      data.source = parseChemicalEquation(data.source);
      data.kind = 'reaction';
    } else if (data.kind === 'formula') {
      if (typeof data.source !== 'string') throw new Error('Chemical formula requires formula text.');
      data.source = parseChemicalFormula(data.source);
      data.kind = 'reaction';
    }
    const result = await new Promise((resolve, reject) => {
      const child = spawn(python, ['-B',worker], { stdio: ['pipe', 'pipe', 'pipe'], env: {PATH:'/usr/bin:/bin', LANG:'en_US.UTF-8', PYTHONNOUSERSITE:'1'} });
      let stdout = '', stderr = '', settled = false;
      const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Chemistry rendering timed out.')); }, 20000);
      child.on('error', error => finish(error));
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > MAX_OUTPUT) { child.kill('SIGKILL'); finish(new Error('Renderer output exceeds limit.')); } });
      child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
      child.on('close', code => { if (code !== 0) return finish(new Error('Chemistry renderer failed.')); try { finish(null, JSON.parse(stdout)); } catch { finish(new Error('Invalid renderer output.')); } });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(data));
    });
    // Coarse rejection at the service boundary. The formula component also
    // rebuilds inline SVG using an allowlist; raw renderer markup is never mounted.
    if (typeof result.svg === 'string' && /<\s*(?:script|foreignObject|iframe)|\son\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|file:|javascript:|\/\/)/i.test(result.svg)) {
      result.svg = null; result.status = 'error'; result.warnings = [...(result.warnings || []), 'Unsafe SVG was rejected.'];
    }
    reply(res, 200, result);
  } catch (error) { reply(res, 400, {status:'error', svg:null, warnings:[error.message]}); }
  return true;
}
