#!/bin/bash
# =============================================================================
# SDK Regression Test — TypeScript / Python / Go CLI against test environment
# Usage: ./scripts/test-sdk-regression.sh [base_url]
# =============================================================================

BASE=${1:-"https://cloud.prismer.dev"}
PASS=0
FAIL=0

ok() { echo "  ✅ $1"; ((PASS++)); }
fail() { echo "  ❌ $1: $2"; ((FAIL++)); }

echo "═══════════════════════════════════════════════════"
echo "  SDK Regression Test"
echo "  Target: $BASE"
echo "═══════════════════════════════════════════════════"

# -----------------------------------------------------------
echo ""
echo "📦 TypeScript SDK"
# -----------------------------------------------------------

cd "$(dirname "$0")/../sdk/typescript"
node -e "
const { PrismerClient } = require('./dist/index.js');
async function test() {
  const c = new PrismerClient({ baseUrl: '$BASE' });
  const evo = c.im.evolution;
  const R = [];

  try { const s = await evo.getStats(); R.push(s?.ok ? '✅ stats' : '❌ stats: not ok'); }
  catch(e) { R.push('❌ stats: '+e.message?.slice(0,50)); }

  try { await evo.getHotGenes(3); R.push('✅ hotGenes'); }
  catch(e) { R.push('❌ hotGenes: '+e.message?.slice(0,50)); }

  try { await evo.browseGenes({category:'repair',limit:2}); R.push('✅ browse'); }
  catch(e) { R.push('❌ browse: '+e.message?.slice(0,50)); }

  try { await evo.getFeed(3); R.push('✅ feed'); }
  catch(e) { R.push('❌ feed: '+e.message?.slice(0,50)); }

  try { await evo.getStories(); R.push('✅ stories'); }
  catch(e) { R.push('❌ stories: '+e.message?.slice(0,50)); }

  try { await evo.getMetrics(); R.push('✅ metrics'); }
  catch(e) { R.push('❌ metrics: '+e.message?.slice(0,50)); }

  try {
    await c.im.account.register({type:'agent',username:'tsdk_'+Date.now(),displayName:'TS SDK Reg'});
    R.push('✅ register');
  } catch(e) { R.push('❌ register: '+e.message?.slice(0,50)); }

  try {
    const a = await evo.analyze({error:'timeout',tags:['sdk_test']});
    R.push(a?.ok ? '✅ analyze' : '❌ analyze: not ok');
  } catch(e) { R.push('❌ analyze: '+e.message?.slice(0,50)); }

  try {
    await evo.createGene({category:'repair',signals_match:['error:ts_sdk'],strategy:['s1'],title:'TS Reg'});
    R.push('✅ createGene');
  } catch(e) { R.push('❌ createGene: '+e.message?.slice(0,50)); }

  R.forEach(r => console.log('  ' + r));
  const p = R.filter(r=>r.startsWith('✅')).length;
  const f = R.filter(r=>r.startsWith('❌')).length;
  console.log('  TS SDK: ' + p + '/' + R.length + ' pass');
  process.exit(f > 0 ? 1 : 0);
}
test().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
" 2>&1

TS_RC=$?
cd "$(dirname "$0")/.."

# -----------------------------------------------------------
echo ""
echo "🐍 Python SDK"
# -----------------------------------------------------------

cd "$(dirname "$0")/../sdk/python"
python3 -c "
import time
from prismer import PrismerClient
c = PrismerClient(base_url='$BASE')
evo = c.im.evolution
R = []

try: evo.get_stats(); R.append('✅ stats')
except Exception as e: R.append(f'❌ stats: {str(e)[:50]}')

try: evo.get_hot_genes(3); R.append('✅ hotGenes')
except Exception as e: R.append(f'❌ hotGenes: {str(e)[:50]}')

try: evo.browse_genes(category='repair',limit=2); R.append('✅ browse')
except Exception as e: R.append(f'❌ browse: {str(e)[:50]}')

try: evo.get_feed(3); R.append('✅ feed')
except Exception as e: R.append(f'❌ feed: {str(e)[:50]}')

try: evo.get_stories(); R.append('✅ stories')
except Exception as e: R.append(f'❌ stories: {str(e)[:50]}')

try: evo.get_metrics(); R.append('✅ metrics')
except Exception as e: R.append(f'❌ metrics: {str(e)[:50]}')

try:
    c.im.account.register(type='agent',username=f'pydk_{int(time.time())}',display_name='Py Reg')
    R.append('✅ register')
except Exception as e: R.append(f'❌ register: {str(e)[:50]}')

try: evo.analyze(error='timeout',tags=['sdk_test']); R.append('✅ analyze')
except Exception as e: R.append(f'❌ analyze: {str(e)[:50]}')

try: evo.create_gene(category='repair',signals_match=['error:py_sdk'],strategy=['s1'],title='Py Reg'); R.append('✅ createGene')
except Exception as e: R.append(f'❌ createGene: {str(e)[:50]}')

for r in R: print(f'  {r}')
p=sum(1 for r in R if r.startswith('✅'))
f=sum(1 for r in R if r.startswith('❌'))
print(f'  Python SDK: {p}/{len(R)} pass')
exit(1 if f > 0 else 0)
" 2>&1

PY_RC=$?
cd "$(dirname "$0")/.."

# -----------------------------------------------------------
echo ""
echo "🔧 Go CLI"
# -----------------------------------------------------------

if [ -f /tmp/prismer-cli ]; then
  # Configure Go CLI
  /tmp/prismer-cli config set default.base_url "$BASE" 2>/dev/null
  /tmp/prismer-cli register "go_reg_$(date +%s)" --display-name "Go Reg" --type agent 2>/dev/null

  R=$(/tmp/prismer-cli evolve stats --json 2>&1)
  if echo "$R" | grep -q '"ok": true'; then
    ok "Go CLI: evolve stats"
  else
    fail "Go CLI: evolve stats" "$(echo "$R" | head -c 80)"
  fi

  R=$(/tmp/prismer-cli evolve genes --json 2>&1)
  if echo "$R" | grep -q '"ok": true'; then
    ok "Go CLI: evolve genes"
  else
    fail "Go CLI: evolve genes" "$(echo "$R" | head -c 80)"
  fi

  R=$(/tmp/prismer-cli evolve metrics --json 2>&1)
  if echo "$R" | grep -q '"ok": true'; then
    ok "Go CLI: evolve metrics"
  else
    fail "Go CLI: evolve metrics" "$(echo "$R" | head -c 80)"
  fi
else
  echo "  ⚠️ Go CLI not built (/tmp/prismer-cli missing). Run: cd sdk/golang && go build -o /tmp/prismer-cli ./cmd/prismer"
fi

# -----------------------------------------------------------
echo ""
echo "📊 Summary"
echo "═══════════════════════════════════════════════════"
echo "  Pass: $PASS  Fail: $FAIL"
echo "═══════════════════════════════════════════════════"
