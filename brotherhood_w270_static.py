from pathlib import Path
s=Path(__file__).resolve().parents[1].joinpath('game.js').read_text();h=Path(__file__).resolve().parents[1].joinpath('index.html').read_text()
for t in ('function combatStress(', 'function brotherhoodRescue(', 'function applyBrotherhoodTrauma(', 'rescueUsed=new Set()', 'applyBrotherhoodTrauma();for(', 'combatStress(a)', 'stress:Math.max(0,Math.min(100', 'trauma:Math.max(0,Math.min(99', 'brotherhood-rescue'):assert t in s,t
assert 'id="brotherhood-rescue"' in h
print('W2.7.0 static checks OK')
