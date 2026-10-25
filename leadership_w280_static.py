from pathlib import Path
p=Path(__file__).resolve().parents[1];s=(p/'game.js').read_text();h=(p/'index.html').read_text()
for v in ('function leadershipRally()', 'function squadCover()', 'function fieldBondSummary()', 'rallyUsedTurn===turn', 'squadCoverUsedTurn===turn', 't.coveredUntil===turn?1:0', 'saveRoster();log(', "$('bond-field').textContent"):
 assert v in s,v
for v in ('id="leadership-rally"','id="squad-cover"','id="bond-field"'):
 assert v in h,v
print('W2.8.0 static checks OK')
