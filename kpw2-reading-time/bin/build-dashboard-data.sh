#!/bin/sh

BASE="${KPW2_BASE:-/mnt/us/kpw2-reading-time}"
DATA="$BASE/reading-time.tsv"
DASH="$BASE/dashboard"
OUT="$DASH/data.js"
TMP="$OUT.tmp"
CC_DB="${KPW2_CC_DB:-/var/local/cc.db}"
CC_COPY="$BASE/.cc-dynamic.db"
CATALOG="$BASE/.dynamic-catalog.tsv"
TAB="$(printf '\t')"

mkdir -p "$DASH" || exit 1
[ -f "$DATA" ] || printf 'date\tbook_id\tseconds\ttitle\n' > "$DATA"
rm -f "$CC_COPY" "$CATALOG"
: > "$CATALOG"

# Read a private copy. The Kindle catalog itself is never modified or held.
if command -v sqlite3 >/dev/null 2>&1 && [ -r "$CC_DB" ] && cp "$CC_DB" "$CC_COPY" 2>/dev/null; then
    sqlite3 -separator "$TAB" "$CC_COPY" \
        "SELECT replace(replace(replace(COALESCE(p_cdeKey,''),char(9),' '),char(10),' '),char(13),' '), replace(replace(replace(COALESCE(p_titles_0_nominal,''),char(9),' '),char(10),' '),char(13),' '), CASE WHEN p_percentFinished IS NULL THEN '' ELSE CAST(p_percentFinished + 0.5 AS INTEGER) END FROM Entries WHERE p_percentFinished IS NOT NULL ORDER BY p_lastAccess DESC;" \
        > "$CATALOG" 2>/dev/null || : > "$CATALOG"
fi
rm -f "$CC_COPY"

generated="$(date '+%Y-%m-%d %H:%M:%S')"
printf 'window.READING_DATA={generatedAt:"%s",entries:[' "$generated" > "$TMP" || exit 1

awk -F '\t' '
function code(t) { return length(t)>=16 && t !~ /[^0-9A-Fa-f]/ }
function usable(t,id) { return t!="" && t!="unknown" && t!=id && !code(t) }
function esc(s) { gsub(/\\/,"\\\\",s);gsub(/"/,"\\\"",s);gsub(/\r/,"",s);gsub(/\n/," ",s);return s }
NR>1 && NF>=3 && $1!="" {
    rows++;date[rows]=$1;id[rows]=$2;sec[rows]=$3+0;raw[rows]=$4
    key=(id[rows]==""||id[rows]=="unknown")?id[rows] SUBSEP raw[rows]:id[rows]
    rowkey[rows]=key
    if(!(key in title)||(!usable(title[key],id[rows])&&usable(raw[rows],id[rows])))title[key]=raw[rows]
    bookid[key]=id[rows]
}
END{
    first=1
    for(n=1;n<=rows;n++){
        name=title[rowkey[n]]
        if(!usable(name,bookid[rowkey[n]]))name=bookid[rowkey[n]]
        if(name==""||name=="unknown")name="未知书籍"
        printf "%s[\"%s\",\"%s\",%d,\"%s\"]",(first?"":","),esc(date[n]),esc(id[n]),sec[n],esc(name)
        first=0
    }
}' "$DATA" >> "$TMP"

printf '],progress:[' >> "$TMP"
awk -F '\t' '
function esc(s){gsub(/\\/,"\\\\",s);gsub(/"/,"\\\"",s);gsub(/\r/,"",s);gsub(/\n/," ",s);return s}
NF>=3 && $3!="" && !seen[$1 SUBSEP $2]++ {
    p=$3+0;if(p<0)p=0;if(p>100)p=100
    printf "%s[\"%s\",\"%s\",%d]",(first++?",":""),esc($1),esc($2),p
}' "$CATALOG" >> "$TMP"
printf ']};\n' >> "$TMP"

mv "$TMP" "$OUT" || exit 1
rm -f "$CATALOG"
chmod 644 "$OUT"
exit 0
