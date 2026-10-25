from pathlib import Path
s=Path(__file__).resolve().parents[1].joinpath('game.js').read_text()
for token in ('const HOME_STATES=', 'function hometown(', 'function sameHometown(', 'data-hometown=', 'sameHometown(r,p)?1:0', 'sameHometown(rec(u.id),rec(p.id))?3:0', 'hometownRescueBonus(t)', 'homeState:INITIAL_HOME[id]', 'homeState:HOME_STATES.includes(v.homeState)'):
 assert token in s,token
print('hometown static checks OK')
