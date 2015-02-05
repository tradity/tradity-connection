/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

if (typeof exports != 'undefined' && exports) {
	var util = require('./util.js');
	var api = require('./sotrade-api.js');
	
	exports.parentPath = util.parentPath;
	exports.locallyUnique = util.locallyUnique;
	exports.detectCycle = util.detectCycle;
	exports.SoTradeConnection = api.SoTradeConnection;
}
