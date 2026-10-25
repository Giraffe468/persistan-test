// Browser inspection: run game with ?test=1 on localhost, then use __persistanTest.vehicleMoves.
// Vehicle movement is bounded to the map, blocked cells and live units are excluded.
console.assert(typeof window.__persistanTest?.vehicleMoves==='function','vehicleMoves must be exposed');
