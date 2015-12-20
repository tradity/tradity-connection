/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

var SoTradeConnection;

(function() {

/* this function replaces itself during its first invocation for lazy loading */
var dbg = function() {
	var debugModule;
	try {
		debugModule = require('debug');
	} catch (e1) {
		try {
			debugModule = debug || (window && window.debug);
		} catch(e2) {
			console.error(e1, e2);
			
			debugModule = function(topic) { return console.log.bind(console, topic); };
		}
	}
	
	dbg = debugModule('sotrade:api');
	
	return dbg.apply(this, arguments);
};

var deepCopy = function(obj) {
	if (!obj || typeof obj !== 'object')
		return obj;
	
	var copy = {};
	for (var key in obj)
		if (obj.hasOwnProperty(key))
			copy[key] = deepCopy(obj[key]);
	return copy;
};

/**
 * Provides {@link module:sotrade-api~SoTradeConnection}.
 * This module can be directly included or <code>require()</code>'d.
 * 
 * @public
 * @module sotrade-api
 */

/**
 * Wrapper object for an underlying socket.io transport.
 * 
 * This object provides an implementation of a stateless request-based protocol
 * on top of the asynchronous event-based socket.io model.
 * 
 * It also implements the (Node.js standard) event emitter interface.
 * 
 * @property {function} connect  A callback that returns a socket.io connection instance
 * @property {object} socket  The underlying socket.io connection instance
 * @property {function} applyWrap  See {@link module:sotrade-api~SoTradeConnection#externallyCalled}
 * @property {object} listeners  Object with event names as keys and arrays of callbacks
 *             as values. The values of these arrays will be called with
 *             the event data structures when an corresponding event is
 *             received.
 * @property {object} pendingIDs  Object with IDs of pending queries as keys and objects
 *             containing information about that query as values. The latter have an
 *             <code>cb</code> entry for a callback that will be triggered when the
 *             reponse arrives and an optional <code>prefill</code> property. If
 *             <code>prefill</code> is given, it should be an object and will be merged
 *             into the response data structure.
 * @property {int} id  Current ID counter, increased for each query
 * @property {?object} lzma  Optional provider of LZMA decompression.
 *             It should provide the <a href="https://github.com/nmrugg/LZMA-JS">LZMA-JS</a>
 *             interface, i.e. an <code>decompress</code> method as described there.
 * @property {function} protocolVersion  A function returning a currently supported protocol version.
 * @property {object} q  A Promise/A+ implementation (e.g. <code>Promise</code> or <code>$q</code>).
 * @property {?string} clientSoftwareVersion  An optional version identifier for this client.
 * @property {function} logDevCheck  A function returning whether to log incoming/outgoing packets
 * @property {function} logSrvCheck  A function returning whether to log server debugging information
 * @property {object} keyStorage  An object providing <code>getKey</code> and <code>setKey</code>
 *             methods for storing the session key.
 * @property {?object} messageSigner  Optional instance of {@link module:signedmsg~SignedMessaging},
 *             used for sending queries with administrative privileges.
 * @property {bool} noSignByDefault  Whether not to sign queries by default if <code>messageSigner</code>
 *             is present.
 * @property {object} qCache  Cache of queries, indexed by the JSON representation of the input.
 * @property {?object} serverConfig  The server config as received in an initial event.
 * @property {int} _txPackets  Number of transmitted packets.
 * @property {int} _rxPackets  Number of received packets.
 * 
 * @public
 * @constructor module:sotrade-api~SoTradeConnection
 */
SoTradeConnection = function(opt) {
	this.connect = opt.connect;
	this.socket = null;
	this.applyWrap = opt.applyWrap || function(f) { f(); };
	this.listeners = {}; // listener name -> array of callbacks
	this.pendingIDs = {}; // numeric id -> {cb: callback for that id, prefill: object}
	this.id = 0;
	this.lzma = opt.lzma || null;
	this.protocolVersion = function() { return 1; };
	this.q = opt.q || (typeof Promise !== 'undefined' ? Promise : null);
	this.clientSoftwareVersion = opt.clientSoftwareVersion || null;
	
	var logDevCheck = opt.logDevCheck || false, logSrvCheck = opt.logSrvCheck || false;
	if (logDevCheck === !!logDevCheck) logDevCheck = function() { return opt.logDevCheck; };
	if (logSrvCheck === !!logSrvCheck) logSrvCheck = function() { return opt.logSrvCheck; };
	this.logDevCheck = logDevCheck;
	this.logSrvCheck = logSrvCheck;
	
	this.keyStorage = opt.keyStorage || SoTradeConnection.defaultKeyStorage();
	this.messageSigner = opt.messageSigner || null;
	this.noSignByDefault = opt.noSignByDefault || false;
	
	this.qCache = {};
	this.serverConfig = null;
	
	this._txPackets = 0;
	this._rxPackets = 0;
	
	this.init();
};

/**
 * Provides a default implementation of a key storage that will be used
 * when no other object is provided as <code>keyStorage</code>.
 * 
 * Returns an object where <code>.getKey()</code> will simply return
 * whichever value was last set via </code>.setKey(k)</code>, otherwise null.
 * 
 * @function module:sotrade-api~SoTradeConnection.defaultKeyStorage
 */
SoTradeConnection.defaultKeyStorage = function() {
	var key = null;
	
	return {
		getKey: function() {
			return key;
		},
		
		setKey: function(k) {
			return key = k;
		}
	};
};

/**
 * Return a function which is identical in behaviour to the input function,
 * but which, when called, will be wrapped in whatever was passed as
 * <code>applyWrap</code> to this object’s constructor.
 * Additionally, <code>this</code> will refer to this object in the returned
 * function.
 * 
 * @param {function} fn  Any function.
 * 
 * @returns {function}  A function with identical parameters and return type.
 * 
 * @function module:sotrade-api~SoTradeConnection#externallyCalled
 */
SoTradeConnection.prototype.externallyCalled = function(fn) {
	var self = this;
	
	return function() {
		var args = arguments;
		
		setTimeout(function() {
			return self.applyWrap(function() {
				return fn.apply(self, args);
			});
		}, 0);
	};
};

/**
 * Sets up the underlying socket.io connection and listeners on that socket.
 * 
 * @function module:sotrade-api~SoTradeConnection#init
 */
SoTradeConnection.prototype.init = function() {
	var self = this;
	var throwUncaughtException = function(e) {
		setTimeout(function() { throw e; }, 0);
	};
	
	self.socket = self.connect();
	
	self.socket.on('response', self.externallyCalled(function(wdata) {
		self.unwrap(wdata).then(self.responseHandler.bind(self)).catch(throwUncaughtException);
	}));
	
	self.socket.on('push', self.externallyCalled(function(wdata) {
		self.unwrap(wdata).then(function(data) {
			dbg('in:push', data);
			
			self._rxPackets++;
			self.invokeListeners(data);
		}).catch(throwUncaughtException);
	}));
	
	self.socket.on('push-container', self.externallyCalled(function(wdata) {
		self.unwrap(wdata).then(function(data) {
			if (data.type != 'debug-info') // server debug info only in server debug mode
				dbg('in:push-container', data);
			
			self._rxPackets++;
			
			for (var i = 0; i < data.pushes.length; ++i)
				self.invokeListeners(data.pushes[i]);
		}).catch(throwUncaughtException);
	}));
	
	self.socket.on('disconnect', self.externallyCalled(function(reason) {
		setTimeout(self.reconnect.bind(self), 2300);
	}));
	
	self.on('internal-server-error', self.resetExpectedResponses.bind(self));
	
	self.on('debug-info', function(data) {
		var args = data.args.slice();
		args.unshift('dbg');
		dbg.apply(dbg, args);
	});
	
	self.on('server-config', function(data) {
		self.serverConfig = data.config;
	});
};

/**
 * Return the underlying socket.io connection.
 * 
 * @function module:sotrade-api~SoTradeConnection#raw
 */
SoTradeConnection.prototype.raw = function() {
	return this.socket;
};

/**
 * Marks all pending queries as possibly unanswered.
 * For example, this can be called in case of a server-side error
 * which may result in a query not returning an answer.
 * 
 * @function module:sotrade-api~SoTradeConnection#resetExpectedResponses
 */
SoTradeConnection.prototype.resetExpectedResponses = function() {
	for (var i in this.pendingIDs)
		if (this.pendingIDs[i])
			this.pendingIDs[i]._expect_no_response = true;
};

/**
 * Forces a reconnect of the underlying socket.
 * 
 * @function module:sotrade-api~SoTradeConnection#reconnect
 */
SoTradeConnection.prototype.reconnect = function() {
	this.resetExpectedResponses();
	
	this.socket.connect(null, 'forceNew');
};

/**
 * Returns true if there any pending queries, i.e. entries in
 * <code>this.pendingIDs</code> which are not marked as not expecting a response.
 * 
 * @function module:sotrade-api~SoTradeConnection#hasOpenQueries
 */
SoTradeConnection.prototype.hasOpenQueries = function() {
	for (var i in this.pendingIDs)
		if (this.pendingIDs[i] && !this.pendingIDs[i]._expect_no_response)
			return true;
	
	return false;
};

/**
 * Invoke all listeners for a given set of incoming data.
 * This includes all listeners which listen on any event (<code>'*'</code>),
 * which listen for this kind of event/response, and which wait for this
 * specific response.
 * 
 * @param {object} data  The incoming data object. Here, only <code>data.type</code> is used.
 * @param {?object} waitentry  An entry in <code>this.pendingIDs</code>, for example.
 * 
 * @function module:sotrade-api~SoTradeConnection#invokeListeners
 */
SoTradeConnection.prototype.invokeListeners = function(data, waitentry) {
	var listener = (waitentry && waitentry.cb) || function() {};
	
	var type = data.type;
	
	// general listeners
	var listeners = (this.listeners[type] || []).concat(this.listeners['*'] || []);
	
	for (var i = 0; i < listeners.length; ++i) 
		if (listeners[i])
			listeners[i](data);
	
	// specific listener
	listener(data);
	
	// deferred promise
	if (waitentry && waitentry.deferred)
		waitentry.deferred.resolve(data);
};

/**
 * Handle incoming data.
 * This includes saving a received session key (e.g. after login), merging in any
 * pre-filled data from the original query, adding timing information and
 * invoking any listeners for the event.
 * 
 * @function module:sotrade-api~SoTradeConnection#responseHandler
 */
SoTradeConnection.prototype.responseHandler = function(data) {
	var rid = data['is-reply-to'].split('--');
	var type = rid[0];
	if ((type == 'login' || data.code == 'login-success' || type == 'register' || (data.code && data.code.match(/^reg-/))) && data.key)
		this.setKey(data.key);
	
	data.type = type;
	
	var numericID = parseInt(rid[1]);
	var waitentry = this.pendingIDs[numericID];
	
	if (waitentry) {
		for (var i in waitentry.prefill) 
			if (typeof data[i] == 'undefined')
				data[i] = waitentry.prefill[i];
	}
	
	var _t = data._t;
	
	_t.csend = data._t_csend; delete data._t_csend; // comes from waitentry.prefill
	_t.sdone = data._t_sdone; delete data._t_sdone; // comes from server
	_t.srecv = data._t_srecv; delete data._t_srecv; // comes from server

	data._dt = {
		cdelta:   _t.crecv - _t.csend,
		inqueue:  _t.srecv - _t.csend,
		sdelta:   _t.ssend - _t.srecv,
		outqueue: _t.crecv - _t.ssend,
		scomp:    _t.ssend - _t.sdone,
		ccomp:    _t.cdeco - _t.crecv
	};
	
	this._rxPackets++;
	
	dbg('Incoming', data);
	
	delete this.pendingIDs[numericID];
	
	this.invokeListeners(data, waitentry);
};

/**
 * Send a request to the server.
 * 
 * @param {string} evname  The name of the request type.
 * @param {object} [data]  Additional request payload (depending on the type).
 * @param {function} [cb]  An optional callback to be invoked when the response is received.
 * 
 * @returns {object} If a promise implementation is present, returns a Q-style promise.
 * 
 * @function module:sotrade-api~SoTradeConnection#emit
 */
SoTradeConnection.prototype.emit = function(evname, data, cb) {
	if (typeof data == 'function') {
		cb = data;
		data = null;
	}
	
	cb = cb || function() {};
	
	data = data || {};
	if (!evname)
		return console.warn('event name missing');
	data.type = evname;
	var id = ++this.id;
	data.id = evname + '--' + id;
	
	if (data.__only_in_dev_mode__ && !this.logDevCheck())
		return cb(null);
	if (data.__only_in_srv_dev_mode__ && !this.logSrvCheck())
		return cb(null);
	
	if (this.getKey() && !data.key)
		data.key = this.getKey();
	
	var deferred = this.q.defer();
	var now = (new Date()).getTime();
	var cacheTime = data._cache * 1000;

	if (cacheTime) {
		var qcid_obj = deepCopy(data);
		delete qcid_obj._cache;
		delete qcid_obj.id;
		var qcid = JSON.stringify(qcid_obj);
		var entry = this.qCache[qcid];
		if (entry && (now - entry._cache_rtime) < cacheTime) {
			setTimeout((function() {
				// cache hit
				this.responseHandler(entry);
				if (cb)
					cb(entry);

				deferred.resolve(entry);
			}).bind(this), 0);

			return deferred.promise;
		} 
		
		// flush outdated cache entries
		var qCacheKeys = Object.keys(this.qCache);
		for (var i = 0; i < qCacheKeys.length; ++i) {
			var k = qCacheKeys[i];
			if (now > this.qCache[k]._cache_ptime)
				delete this.qCache[k];
		}
		
		// cache miss
		delete this.qCache[qcid];
		
		// add handler to called *before* the actual callback,
		// which inserts the result into the cache table
		var oldCB = cb;
		cb = (function(entry) {
			// insert into cache
			
			var now = new Date().getTime();
			entry._cache_rtime = now;
			entry._cache_ptime = now + cacheTime;
			this.qCache[qcid] = entry;
			oldCB(entry);
		}).bind(this);
	}
	
	var prefill = data._prefill || {};
	prefill._t_csend = new Date().getTime();
	prefill._reqsize = JSON.stringify(data).length;
	
	this.pendingIDs[id] = {
		cb: cb,
		deferred: deferred,
		prefill: prefill,
		_expect_no_response: data._expect_no_response
	};
	
	this._txPackets++;
	
	if (this.lzma) {
		data.lzma = 1;
		data.csupp = {lzma: 1, s:1}; /* support lzma, split compression */
	}
	
	data.pv = this.protocolVersion();
	
	if (this.clientSoftwareVersion)
		data.cs = this.clientSoftwareVersion;
	
	dbg('Outgoing', data);
	
	var emit = (function(data) { this.socket.emit('query', data); }).bind(this);
	if (this.messageSigner && ((!data.__dont_sign__ && !this.noSignByDefault) || data.__sign__)) {
		this.messageSigner.createSignedMessage(data).then(function(signedData) {
			emit({ signedContent: signedData });
		});
	} else {
		emit(data);
	}
	
	if (evname == 'logout') 
		this.setKey(null);
	
	return deferred.promise;
};

/**
 * Return the current session key.
 * 
 * @function module:sotrade-api~SoTradeConnection#getKey
 */
SoTradeConnection.prototype.getKey = function() {
	return this.keyStorage.getKey();
};

/**
 * Set the current session key and, if appropriate, clear the cache.
 * 
 * @function module:sotrade-api~SoTradeConnection#setKey
 */
SoTradeConnection.prototype.setKey = function(k) {
	dbg('Set session key', k);
	
	if (k != this.keyStorage.getKey()) {
		this.qCache = {};
	}
	
	return this.keyStorage.setKey(k);
};

/**
 * Behaves like {@link module:sotrade-api~SoTradeConnection#on},
 * except that after the event was triggered once, the listener is removed.
 * Also, <code>cb</code> is optional, since a promise can be used instead.
 * 
 * @returns {object} If a promise implementation is present, returns a Q-style promise.
 * 
 * @function module:sotrade-api~SoTradeConnection#once
 */
SoTradeConnection.prototype.once = function(evname, cb) {
	cb = cb || function() {};
	
	var destroyCb = null;
	
	var fakeEventEmitter = {
		on: function(evname, fn) {
			destroyCb = fn;
		}
	};
	
	var deferred = this.q.defer();
	
	var cb_ = function() {
		destroyCb();
		
		cb.apply(this, arguments);
		
		deferred.resolve(Array.prototype.slice.apply(arguments));
	};
	
	this.on(evname, cb_, fakeEventEmitter);
	
	return deferred.promise;
};

/**
 * Listens on a event/response type.
 * 
 * @param {string} evname  A valid event or response type or <code>'*'</code>
 * @param {function} cb  A callback that will be invoked when this event is triggered,
 *             with the event/response payload as a parameter.
 * @param {object} [angularScope]  An event emitter exposing the <code>'$destroy'</code>
 *             or <code>'destroy'</code> event. When triggered, this listener will remove
 *             itself.
 * 
 * @function module:sotrade-api~SoTradeConnection#on
 */
SoTradeConnection.prototype.on = function(evname, cb, angularScope) {
	var index = (this.listeners[evname] = (this.listeners[evname] || [])).push(cb) - 1;
	
	var cbExternal = this.externallyCalled(cb);
	this.socket.on(evname, cbExternal);
	
	if (angularScope) {
		var self = this;
		
		var listenerDelete = function() {
			delete self.listeners[evname][index];
			self.socket.removeListener(evname, cbExternal);
		};
		
		if (angularScope.$on) angularScope.$on('$destroy', listenerDelete);
		if (angularScope.on)  angularScope.on ('destroy',  listenerDelete);
	}
};

/**
 * Processes a raw server response, esp. decompresses it if encoded.
 * Also, some fields for information on performance are added
 * (time of receival, decode time, encoded/decoded size).
 * 
 * @param {object} data  A raw server response.
 * 
 * @return {object} A promise for the decoded response
 * 
 * @function module:sotrade-api~SoTradeConnection#unwrap
 */
SoTradeConnection.prototype.unwrap = function(data) {
	var recvTime = new Date().getTime();
	var decsize = 0, encsize = 0;
	
	dbg('Message with encoding', data.e);
	var self = this;
	var q = self.q;
	
	return q.resolve().then(function() {
		if (data.e === 'lzma' && self.lzma) {
			return self.lzma.decompress(new Uint8Array(data.s)).then(function(s) {
				var decoded = JSON.parse(s);
				decsize = s.length;
				encsize = data.s.byteLength || data.s.length;
				return decoded;
			});
		} else if (data.e == 'split' && self.lzma) {
			/* split compression support */
			var decoded = {};
			var decodedCount = 0;
			
			if (data.s.length == 0)
				return {};
			
			return q.all(data.s.map(function(piece) {
				encsize += piece.s.byteLength || piece.s.length;
				
				return self.unwrap(piece).then(function(s) {
					decsize += s.length;
					
					var obj = s;
					for (var i in obj)
						decoded[i] = obj[i];
				});
			})).then(function() {
				return decoded;
			});
		} else if (data.e === 'raw') {
			decsize = data.s.length;
			encsize = data.s.length;
			return JSON.parse(data.s);
		}
		
		return q.reject(new Error('Unknown/unsupported encoding: ' + data.e));
	}).then(function(e) {
		e._t = e._t || {};
		e._t.crecv = recvTime;
		e._t.ssend = data.t;
		e._t.cdeco = new Date().getTime();
		e._resp_encsize = encsize;
		e._resp_decsize = decsize;
		return e;
	});
};

/**
 * Returns the number of transmitted packets.
 * 
 * @function module:sotrade-api~SoTradeConnection#txPackets
 */
SoTradeConnection.prototype.txPackets = function() { return this._txPackets; };

/**
 * Returns the number of received packets.
 * 
 * @function module:sotrade-api~SoTradeConnection#rxPackets
 */
SoTradeConnection.prototype.rxPackets = function() { return this._rxPackets; };

})();

if (typeof exports != 'undefined' && exports)
	exports.SoTradeConnection = SoTradeConnection;
