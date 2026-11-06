#!/usr/bin/env python3
"""Exercise the built image without host ports, production secrets, or outbound network."""
import subprocess
import sys
import uuid

PORT = 3000
ENV = {'FIREFLY_API_URL': 'https://firefly.invalid/api/v1', 'FIREFLY_API_TOKEN': 'test-only', 'MCP_HTTP_TOKEN': 'test-only', 'MCP_HTTP_HOST': '0.0.0.0'}
CHECK = "await status('/health',200);const h=await (await fetch(base+'/health')).json();if(h.ok!==true||h.auth!=='bearer')throw Error('health/auth');await status('/mcp',401,{method:'POST'});const r=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});const body=await r.text();if(!r.ok||!body.includes('firefly_query')||body.includes('firefly_execute'))throw Error('MCP surface');"

def run(args, timeout=45):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Image smoke command failed: ' + result.stderr[-2000:])
    return result.stdout

def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: candidate-smoke.py IMAGE')
    name = 'candidate-smoke-' + uuid.uuid4().hex[:12]
    command = ['docker', 'run', '-d', '--name', name, '--network', 'none',
               '--memory', '512m', '--cpus', '1', '--pids-limit', '128']
    for key, value in ENV.items():
        command.extend(['-e', key + '=' + value])
    command.append(sys.argv[1])
    try:
        run(command)
        script = """
const base='http://127.0.0.1:3000';
let ready=false;
for(let i=0;i<30;i++){try{const r=await fetch(base+'/health');if(r.status===200){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,500))}
if(!ready)throw Error('application did not become ready');
async function status(path,expected,options){const r=await fetch(base+path,{...options,redirect:'manual'});if(r.status!==expected)throw Error(path+': expected '+expected+', got '+r.status);return r}
""" + CHECK
        run(['docker', 'exec', name, 'node', '--input-type=module', '-e', script])
        print('Exact-image smoke checks passed (network none, no host ports).')
    finally:
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True)

if __name__ == '__main__':
    main()
