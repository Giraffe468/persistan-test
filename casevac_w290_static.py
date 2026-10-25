from pathlib import Path
p=Path(__file__).resolve().parents[1];s=(p/'game.js').read_text();h=(p/'index.html').read_text()
for v in ('function registerCasualties()', 'function casualtyTick()', 'function stabilizeCasualty()', 'function carryCasualty()', 'function evacuateCasualty()', 'evacRescues++', 'sameHometown(a,b)?1:0', 'patient.x=unit.x', 'u.evacuated||(u.downed&&u.stabilized)'):
 assert v in s,v
for v in ('id="stabilize-casualty"','id="carry-casualty"','id="evacuate-casualty"','id="casualty-status"'):
 assert v in h,v
print('W2.9.0 CASEVAC static checks OK')
