"""Build app/quran/* from the `quran` npm package (Tanzil Uthmani text + Shakir English)
and the `quran-json` package (Tanzil English transliteration).
Usage: python3 tools/build-quran.py <quran pkg dir> <quran-json pkg dir> <out dir>"""
import json, os, sqlite3, sys

qdir, qjdir, out = sys.argv[1:4]
db = sqlite3.connect(os.path.join(qdir, 'data', 'qurandb'))
translit = json.load(open(os.path.join(qjdir, 'dist', 'quran_transliteration.json'), encoding='utf-8'))

os.makedirs(os.path.join(out, 's'), exist_ok=True)
BISM = db.execute('select ar from ar where chapter=1 and verse=1').fetchone()[0]  # exact Tanzil codepoints
chapters = db.execute('select id, ayas, arname, tname, enname, type, ord from chapters where id between 1 and 114 order by id').fetchall()
juz = [list(r) for r in db.execute('select surah, ayah from juz where id between 1 and 30 order by id')]
assert len(chapters) == 114 and len(juz) == 30

meta = []
total = 0
for cid, ayas, arname, tname, enname, typ, order in chapters:
    ar = [r[0] for r in db.execute('select ar from ar where chapter=? order by verse', (cid,))]
    en = [r[0] for r in db.execute('select en from en where chapter=? order by verse', (cid,))]
    tr_src = translit[cid - 1]
    tr = [v['transliteration'] for v in tr_src['verses']]
    assert len(ar) == len(en) == len(tr) == ayas, cid
    if cid not in (1, 9):
        # Tanzil prefixes ayah 1 with the basmala (4 words; some surahs mark it with an extra shadda)
        words = ar[0].split(' ')
        bare = lambda w: ''.join(ch for ch in w if not ('\u064b' <= ch <= '\u0670'))
        assert [bare(w) for w in words[:4]] == [bare(w) for w in BISM.split(' ')], cid
        ar[0] = ' '.join(words[4:])
    total += ayas
    meta.append({'n': cid, 'ar': arname, 'tr': tname, 'en': enname, 'ayahs': ayas, 'type': typ, 'order': order})
    body = json.dumps({'ar': ar, 'tr': tr, 'en': en}, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(out, 's', f'{cid:03d}.js'), 'w', encoding='utf-8') as f:
        f.write(f'SakinaQuran.loaded({cid},{body});\n')

assert total == 6236
index = {'surahs': meta, 'juz': juz, 'bismillah': BISM,
         'credits': 'Arabic text: Tanzil Quran Text (Uthmani), tanzil.net, CC BY 3.0, unchanged. '
                    'English: M. H. Shakir, and transliteration, both via tanzil.net.'}
with open(os.path.join(out, 'index.js'), 'w', encoding='utf-8') as f:
    f.write('window.SakinaQuranIndex = ' + json.dumps(index, ensure_ascii=False, separators=(',', ':')) + ';\n')
print('ok', total)
