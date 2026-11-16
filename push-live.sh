#!/bin/bash
# 把工作区的插件代码推到「当前正在运行的那一代」上，靠 client-hmr 的 500ms stat 轮询热替换。
#
# 为什么不能只推一份：Host 启动时解析到某一份 generation 目录并一直服务它，
# 页面里跑的是那一份。我们无法从外部查询它到底指向哪一代，所以：
#   - 默认把代码推到所有 dsh-i-hao-hai-pa 的 generation 目录（覆盖式），
#     命中哪一个都能在 1 秒内热更新；
#   - 旧目录本来也不会再被加载，覆盖没有副作用。
#
# 用法：./push-live.sh [版本号]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
GEN_ROOT="$HOME/Library/Application Support/dsh-desktop/harness/profiles/.generations/live"
VERSION="${1:-}"

if [ -n "$VERSION" ]; then
  python3 - "$ROOT/client.js" "$VERSION" <<'PY'
import sys, re
path, version = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf8').read()
s2 = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{version}';", s, count=1)
open(path, 'w', encoding='utf8').write(s2)
print('workspace version ->', version)
PY
fi

count=0
for dir in "$GEN_ROOT"/dsh-i-hao-hai-pa+*/node_modules/dsh-i-hao-hai-pa; do
  [ -d "$dir" ] || continue
  cp "$ROOT/client.js" "$dir/client.js"
  count=$((count + 1))
done

echo "pushed to $count generation(s)"
echo "现在看 DSH 右下角小条，1 秒内应该更新；没变就说明那一代不是它在用的。"
