'use strict';

var nools = require("nools");
var mqtt = require('mqtt');
var config = require('./config.json');
var subscriptions = require('./topics.json');
/*
var subscriptions = [ // Todo put in config or json file
	"events/otgw/otmonitor/flame",
	"events/rflink/newkaku/00fb09de/a/cmd",
	"events/astronomy/SunlightTimes/sunset",
	"events/astronomy/SunlightTimes/goldenHour"
];
*/
var messages = {},
	mclient, 
	connected;

//memory leak warning
require('events').EventEmitter.prototype._maxListeners = 0;

// Constructor for the message class
var Message = function(packet) {
	this.updatePayload = function(packet) {
		this.p_previous = this.p;
		this.p = packet.payload;
		this.changed = this.p_previous != this.p;
		this.retained = packet.retain;
		this.lastChange = this.currentChange;
		this.currentChange = new Date();
	};

	this.changedFromTo = function(from, to) {
		return this.changed && this.p_previous == from && this.p == to;
	};
	this.changedTo = function(to) {
		return this.changed && this.p == to;
	};
	this.changedFrom = function(from) {
		return this.changed && this.p_previous == from;
	};

	this.t = packet.topic;
	this.updatePayload(packet);
	this.currentChange = new Date();
	this.lastChange = undefined;

	//aliases
	this.payload = this.p;
	this.topic = this.t;
};

// Constructor for the clock class
var Clock = function(){
    this.date = new Date();
	
	Number.prototype.between = function (min, max) {
		return this >= min && this <= max;
	};	
		
    this.getHours = function() {
        return this.date.getHours();
    };

    this.getMinutes = function() {
        return this.date.getMinutes();
    };	

/*	
    this.hoursIsBetween = function(a, b) {
			if(a <= b) return this.date.getHours() >= a && this.date.getHours() <=b;
			else return this.date.getHours() >= a || this.date.getHours() <= b;
    };
*/		

	this.hoursIsBetween = function(a, b) {
		if((this.date.getHours()).between(a,b)) return true;		
		else return false;		
    };	

    //c.inMinutes(0,30)
	this.inMinutes = function(a, b) {
		if((this.date.getMinutes()).between(a,b)) return true;		
		else return false;		
    };
	
	//c.isMinute(04)
    this.isMinute = function(a) {
        if(a == this.date.getMinutes()) return true;			
		else return false;				
    };	
	
    this.step = function(){
        this.date = new Date();
        this.isMorning = this.hoursIsBetween(6, 11);
        this.isNoon = this.hoursIsBetween(12, 14);
        this.isAfternoon = this.hoursIsBetween(15, 17);
        this.isEvening = this.hoursIsBetween(18, 23);
        this.isNight = this.hoursIsBetween(0,5);
	
        return this;
    };
};

const flowOptions = {
	define: {
		Message: Message, 
		Clock: Clock		
	},
	scope: {
		sayHi: sayHi,
		forget: forget, 
		unchange: unchange, 
		publish: publish,
		subscribe: subscribe,
		matchHoursMinutes: matchHoursMinutes
	}
};

//var flow = nools.compile(__dirname + "/ruleset.nools", {define: {Message: Message, homa: homa, publish: homa.mqttHelper.publish, log: homa.logger, forget: forget, Clock: Clock}});
var flow = nools.compile(__dirname + "/ruleset.nools", flowOptions);
var session = flow.getSession();
var clock = new Clock();
session.assert(clock);

// It is a good idea to forget knowledge that triggered a rule which publishes things
// Otherwise the rule would fire again if the publish is received and the session is matched, resulting in an infinite loop
function forget(m) {
    if (m.t in messages) {
        console.log("RULES", "RETRACTING <= " + m.t + ":" + m.p);
        session.retract(m);
        delete messages[m.t];  
    }
}

// This will no longer retract (forget) the fact, but just disable it to trigger more than once (unchange) 
// and keep the fact available to be used in other scenes as a condition.
function unchange(m) {
    if (m.t in messages) {
        console.log("RULES", "UNCHANGE <= " + m.t + ":" + m.p); 
    }
}

// publish to mqtt
function publish(topic, payload, retained) {	
	console.log("MQTT","Publish => " + topic + ":" + payload);
	mclient.publish(topic, payload, {retain: retained});
}

//subscribe to mqtt
function subscribe(topic) {	
	mclient.subscribe(topic);	
	console.log("MQTT","Subscribe => " + topic);
}

// test
function sayHi() {
  console.log('Hello');
}

function matchHoursMinutes(a,b){
	if((new Date(a).setSeconds(0,0)) == (new Date(b).setSeconds(0,0))) return true;		
	else return false;	
}

mclient = mqtt.connect(config.mqtt_broker, config.mqtt_port, config.mqtt_options); 
mclient.publish('connected/' + config.app_name , '1');

mclient.on('connect', function () {
    connected = true;
    console.log("MQTT",'connected => ' + config.mqtt_broker);

    subscriptions.topics.forEach(function (topic) {
        console.log("MQTT",'subscribe ' + topic);
        mclient.subscribe(topic);
    });	
	
});

mclient.on('close', function () {
    if (connected) {
        connected = false;
        console.log("MQTT",'closed => ' + config.mqtt_broker);
    }
});

mclient.on('error', function () {
    console.error("MQTT",'error => ' + config.mqtt_broker);
});

//Event(mqtt) related stuff
mclient.on('message', function(topic, msg) {
	//console.log(topic, message);
	var packet = {};
	packet.topic = topic;
	packet.payload = msg;
    if (packet.topic in messages) {
        var m = messages[packet.topic];
        if(packet.payload) {
            console.log("RULES", "MODIFYING => " + packet.topic + ":" + packet.payload);
            m.updatePayload(packet);
            session.modify(m);
        } else {
            forget(m);
        }
    } else {
        if(!packet.payload) {
            return;
        }
        console.log("RULES", "ASSERTING => " + packet.topic + ":" + packet.payload);
        var m = new Message(packet);
        messages[packet.topic] = m;
        session.assert(m);
    }

    session.modify(clock.step());
    session.match();
});

//Time related stuff
function matchtimer() {
    session.modify(clock.step());
    session.match();
};

setInterval(matchtimer,60*1000);//interval 60 second
