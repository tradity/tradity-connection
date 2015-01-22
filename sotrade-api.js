'use strict';

// socket.io wrapper object
var SoTradeConnection = function(opt) {
	this.connect = opt.connect;
	this.socket = null;
	this.applyWrap = opt.applyWrap || function(f) { f(); };
	this.listeners = {}; // listener name -> array of callbacks
	this.ids = {}; // numeric id -> {cb: callback for that id, prefill: object}
	this.id = 0;
	this.lzma = opt.lzma || null;
	this.protocolVersion = function() { return 1; };
	this.q = opt.q;
	
	var logDevCheck = opt.logDevCheck || false, logSrvCheck = opt.logSrvCheck || false;
	if (logDevCheck === !!logDevCheck) logDevCheck = function() { return opt.logDevCheck; };
	if (logSrvCheck === !!logSrvCheck) logSrvCheck = function() { return opt.logSrvCheck; };
	this.logDevCheck = logDevCheck;
	this.logSrvCheck = logSrvCheck;
	
	this.keyStorage = opt.keyStorage || SoTradeConnection.defaultKeyStorage();
	this.messageSigner = opt.messageSigner || null;
	
	this.qCache = {};
	
	this._txPackets = 0;
	this._rxPackets = 0;
	
	this.init();
};

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

SoTradeConnection.prototype.externallyCalled = function(fn) {
	var self = this;
	return function() {
		var args = arguments;
		
		return self.applyWrap(function() {
			return fn.apply(self, args);
		});
	};
};

SoTradeConnection.prototype.datalog = function() {
	if (this.logDevCheck())
		return console.log.apply(console, arguments);
};

SoTradeConnection.prototype.init = function() {
	this.socket = this.connect();
	
	this.socket.on('response', this.externallyCalled(function(wdata) {
		this.unwrap(wdata, this.responseHandler.bind(this));
	}));
	
	this.socket.on('push', this.externallyCalled(function(wdata) {
		this.unwrap(wdata, (function(data) {
			this.datalog('!', data);
			
			this._rxPackets++;
			this.invokeListeners(data);
		}).bind(this));
	}));
	
	this.socket.on('push-container', this.externallyCalled(function(wdata) {
		this.unwrap(wdata, (function(data) {
			if (data.type != 'debug-info') // server debug info only in server debug mode
				this.datalog('!', data);
			
			this._rxPackets++;
			
			for (var i = 0; i < data.pushes.length; ++i)
				this.invokeListeners(data.pushes[i]);
		}).bind(this));
	}));
	
	this.socket.on('disconnect', this.externallyCalled(function(reason) {
		setTimeout((function() {
			this.reconnect();
		}).bind(this), 2300);
	}));
	
	this.on('internal-server-error', (function() {
		this.resetExpectedResponses();
	}).bind(this));
	
	this.on('debug-info', (function(data) {
		var args = data.args.slice();
		args.unshift('~!');
		this.datalog.apply(this, args);
	}).bind(this));
};

SoTradeConnection.prototype.raw = function() {
	return this.socket;
};

SoTradeConnection.prototype.resetExpectedResponses = function() {
	for (var i in this.ids)
		if (this.ids[i])
			this.ids[i]._expect_no_response = true;
};

SoTradeConnection.prototype.reconnect = function() {
	this.resetExpectedResponses();
	
	this.socket.connect(null, 'forceNew');
};

SoTradeConnection.prototype.hasOpenQueries = function() {
	for (var i in this.ids)
		if (this.ids[i] && !this.ids[i]._expect_no_response)
			return true;
	return false;
};

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

SoTradeConnection.prototype.responseHandler = function(data) {
	var rid = data['is-reply-to'].split('--');
	var type = rid[0];
	if ((type == 'login' || data.code == 'login-success' || type == 'register' || (data.code && data.code.match(/^reg-/))) && data.key)
		this.setKey(data.key);
	
	data.type = type;
		
	var numericID = parseInt(rid[1]);
	var waitentry = this.ids[numericID];
	
	if (waitentry) {
		for (var i in waitentry.prefill) 
			if (typeof data[i] == 'undefined')
				data[i] = waitentry.prefill[i];
	}
	
	if (this.logDevCheck()) {
		data._dt_cdelta   = data._t_crecv - data._t_csend;
		data._dt_inqueue  = data._t_srecv - data._t_csend;
		data._dt_sdelta   = data._t_ssend - data._t_srecv;
		data._dt_outqueue = data._t_crecv - data._t_ssend;
		data._dt_scomp    = data._t_ssend - data._t_sdone;
		data._dt_ccomp    = data._t_cdeco - data._t_crecv;
	}
	
	this._rxPackets++;
	
	this.datalog('<', data);
	
	delete this.ids[numericID];
	
	this.invokeListeners(data, waitentry);
};

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
	
	var now = (new Date()).getTime();
	var cacheTime = data._cache * 1000;
	if (cacheTime) {
		var qcid_obj = $.extend(true, {}, data);
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
			}).bind(this), 0);
			return this.q ? this.q(entry) : null;
		} 
		
		$.each(Object.keys(this.qCache), (function(i, k) { if (now > this.qCache[k]._cache_ptime) delete this.qCache[k]; }).bind(this));
		
		// cache miss
		delete this.qCache[qcid];
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
	
	var deferred = this.q ? this.q.defer() : null;
	
	this.ids[id] = {
		cb: cb,
		deferred: deferred,
		prefill: prefill,
		_expect_no_response: data._expect_no_response
	};
	
	this._txPackets++;
	
	if (this.lzma)
		data.lzma = 1;
		
	data.pv = this.protocolVersion();
	
	this.datalog('>', data);
	
	var emit = (function(data) { this.socket.emit('query', data); }).bind(this);
	if (this.messageSigner && !data.__dont_sign__) {
		this.messageSigner.createSignedMessage(data, function(signedData) {
			emit({ signedContent: signedData });
		});
	} else {
		emit(data);
	}
	
	if (evname == 'logout') 
		this.setKey(null);
	
	return deferred ? deferred.promise : null;
};

SoTradeConnection.prototype.getKey = function() {
	return this.keyStorage.getKey();
};

SoTradeConnection.prototype.setKey = function(k) {
	this.datalog('#', 'key = ' + k);
	
	if (k != this.keyStorage.getKey()) {
		this.qCache = {};
	}
	
	return this.keyStorage.setKey(k);
};

SoTradeConnection.prototype.once = function(evname, cb) {
	cb = cb || function() {};
	
	var destroyCb = null;
	
	var fakeEventEmitter = {
		on: function(evname, fn) {
			destroyCb = fn;
		}
	};
	
	var deferred = this.q ? this.q.defer() : null;
	
	var cb_ = function() {
		destroyCb();
		
		cb.apply(this, arguments);
		
		if (deferred)
			deferred.resolve(Array.prototype.slice.apply(arguments));
	};
	
	this.on(evname, cb_, fakeEventEmitter);
	
	return deferred.promise;
};

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

SoTradeConnection.prototype.unwrap = function(data, cb) {
	var recvTime = new Date().getTime();
	(this.lzma && data.e == 'lzma' ? function(cont) {
		this.lzma.decompress(new Uint8Array(data.s), cont);
	} : function(cont) {
		if (data.e != 'raw') {
			console.warn(data);
			throw new Error('Unknown/unsupported encoding: ' + data.e);
		}
		
		cont(data.s);
	}).bind(this)(function(decoded) {
		var e = JSON.parse(decoded);
		e._t_crecv = recvTime;
		e._t_ssend = data.t;
		e._t_cdeco = new Date().getTime();
		e._resp_encsize = data.s.byteLength || data.s.length;
		e._resp_decsize = decoded.length;
		cb(e);
	});
};

SoTradeConnection.prototype.txPackets = function() { return this._txPackets; };
SoTradeConnection.prototype.rxPackets = function() { return this._rxPackets; };

if (typeof exports != 'undefined' && exports)
	exports.SoTradeConnection = SoTradeConnection;
