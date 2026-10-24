#!/usr/bin/env bash
# 起一个独立的测试实例（克隆目录 + 库快照 + 自己的端口），供全量复测多路并发用（2026-10-22）。
# 用法（在仓库目录）：
#   scripts/retest-clone.sh <N> [源库]        # N=1..29：网页 394N、假 NapCat 300(N+1)；克隆在 $MUMU_CLONE_DIR（默认 /tmp/mumu-retest-N）
#   scripts/retest-clone.sh <N> --stop        # 停掉这一路并删克隆目录（库只是副本）
# 之后：npx tsx scripts/fake-onebot.ts --mumu http://127.0.0.1:394N --port 300(N+1) <场景…>
#       MUMU_URL=http://127.0.0.1:394N npx tsx scripts/probe.ts
# 规矩：不清任何东西——源库只做 VACUUM INTO 快照；端口写进副本的 config 表（surface-web.port / surface-onebot.url）。
set -euo pipefail
N="${1:?用法：retest-clone.sh <N> [源库 | --stop]}"
# 10..29 也行（网页 394NN、假 NapCat 300(N+1) 五位端口照样合法）：同时跑好几个副本时各占一段，别撞号
case "$N" in [1-9]|[12][0-9]) ;; *) echo "N 要是 1..29" >&2; exit 1 ;; esac
PORT="394$N"
NAPCAT="300$((N + 1))"
DIR="${MUMU_CLONE_DIR:-/tmp/mumu-retest-$N}"

if [ "${2:-}" = "--stop" ]; then
  pids=$(pgrep -f "tsx src/main.ts" || true)
  for p in $pids; do
    if lsof -p "$p" 2>/dev/null | grep -q "cwd .*$DIR\$"; then kill "$p" && echo "停了实例 $PORT（pid $p）"; fi
  done
  rm -rf "$DIR" "$DIR.log" && echo "删了 $DIR"
  exit 0
fi

SRC="${2:-data/mumu.db}"
[ -f "$SRC" ] || { echo "源库不存在：$SRC" >&2; exit 1; }
[ -d "$DIR" ] && { echo "$DIR 已存在，先 --stop" >&2; exit 1; }

rsync -a --exclude node_modules --exclude data --exclude .git --exclude 'apps/web/node_modules' ./ "$DIR"/
ln -s "$PWD/node_modules" "$DIR/node_modules"
mkdir -p "$DIR/data"
# 兴趣插件的本地向量模型（几十到几百 MB）共用一份，不然每一路都要重新下载
mkdir -p data/models && ln -s "$PWD/data/models" "$DIR/data/models"
sqlite3 "$SRC" "VACUUM INTO '$DIR/data/mumu.db'"
sqlite3 "$DIR/data/mumu.db" "update config set value=json_set(value,'\$.\"surface-web\".port',$PORT,'\$.\"surface-onebot\".url','ws://127.0.0.1:$NAPCAT') where key='plugins'"
# 后台起实例：stdin 接 /dev/null、disown，脚本不等它（第一次写成 `( … &)` 时脚本挂在这里不退）
cd "$DIR"
nohup npm start > "$DIR.log" 2>&1 < /dev/null &
disown
cd - > /dev/null
for _ in $(seq 1 60); do
  if curl -s "127.0.0.1:$PORT/api/meta" > /dev/null; then break; fi
  sleep 1
done
curl -s "127.0.0.1:$PORT/api/meta" >/dev/null || { echo "实例没起来，看 $DIR.log" >&2; exit 1; }
SEQ=$(sqlite3 -readonly "$DIR/data/mumu.db" 'select max(seq) from events')
echo "实例 $N：网页 http://127.0.0.1:$PORT，假 NapCat 用 --port $NAPCAT，目录 $DIR，起始 seq $SEQ（统计用 npx tsx scripts/test-stats.ts $SEQ 9999999 $DIR/data/mumu.db）"
