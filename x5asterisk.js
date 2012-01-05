/**
 * Modified version of https://github.com/mscdex/node-asterisk
 */
/**
 * Load required libraries
 */
var sys                 = require("sys"),
    inherits            = sys.inherits,
    EventEmitter        = require("events").EventEmitter,
    net                 = require("net");

/**
 * Globals vars "constants"
 */
var CRLF                = "\r\n",
    END                 = "\r\n\r\n";

/**
 * The core!
 */
exports.AsteriskManager = function(newconfig)
{
    // Start the event emiter.
    EventEmitter.call(this);

    // Configuration stuff
    var default_config  = {
        user            : null,
        password        : null,
        host            : "localhost",
        port            : 5038,
        events          : "on",
        debug           : "off",
        inbound         : ["ext-did"], // Context(s) for inbound calls
        outbound        : [],          // Context(s) for outbound calls
        internal        : [],          // Context(s) for internal calls
        connect_timeout : 0 // the time to wait for a connection to the Asterisk server (in milliseconds)
    };

    // Define some empty vars.
    var tmoConn         = null;
    var conn            = null;
    var self            = this;
    var loggedIn_       = false;
    var loginId         = null;
    var buffer          = "";
    var actions         = {};
    var partcipants     = {};
    var config;

    /**
     * Fill in the configaration
     */
    this.setConfig      = function(newconfig)
    {
        config = {};

        for(var option in default_config)
        {
            config[option] = (typeof newconfig[option] != "undefined" ? newconfig[option] : default_config[option]);
        }
    };

    /**
     * Send data to Asterisk Manager
     */
    this.send           = function(req, cb)
    {
        var id       = (new Date()).getTime();
        actions[id]  = {
            request  : req,
            callback : cb
        };
        var msg      = "";

        for (var key in req)
        {
            msg += key + ": " + req[key] + CRLF;
        }

        msg         += "actionid: " + id + CRLF + CRLF;

        if (req.action == "login")
        {
            loginId = id;
        }

        self.conn.write(msg);
    };

    /**
     * Get data for a participant
     */
    this.getParticipant = function(id)
    {
        return self.participants[id];
    }

    /**
     * Do this when connected
     */
    this.OnConnect      = function()
    {
        self.participants = {};

        if(config.connect_timeout > 0)
        {
            clearTimeout(self.tmoConn);
        }

        self.emit("serverconnect");
    };

    /**
     * Handle connection errors
     */
    this.OnError        = function(err)
    {
        self.conn.end();
        self.emit("servererror", err);
    };

    /**
     * Handle disconnecting
     */
    this.OnClose        = function(had_error)
    {
        self.emit("serverdisconnect", had_error);
        self.conn.destroy();

        loggedIn_ = false;
    };

    /**
     * Disconnect
     */
    this.OnEnd          = function()
    {
        self.conn.end();
        this.OnClose(false);
    };

    /**
     * Deal with data from Asterisk Manager
     */
    this.OnData         = function(tcpbuffer)
    {
        /**
         * Convert data to a string, buffer it, parse it, fire "response" or "event" code.
         */
        data    = tcpbuffer.toString();

        if(data.substr(0, 21) == "Asterisk Call Manager")
        {
            data = data.substr(data.indexOf(CRLF)+2); // skip the server greeting when first connecting
        }

        buffer += data;

        var iDelim,
            info,
            headers,
            kv,
            type;

        while((iDelim = buffer.indexOf(END)) > -1)
        {
            info    = buffer.substring(0, iDelim+2).split(CRLF);
            buffer  = buffer.substr(iDelim + 4);
            headers = {};
            type    = "";
            kv      = [];

            for(var i = 0, len = info.length; i < len; i++)
            {
                if(info[i].indexOf(": ") == -1)
                {
                    continue;
                }

                kv             = info[i].split(": ", 2);
                kv[0]          = kv[0].toLowerCase().replace("-", "");

                if(i == 0)
                {
                    type = kv[0];
                }

                headers[kv[0]] = kv[1];
            }

            switch(type)
            {
                case "response":
                    self.OnResponse(headers);
                break;

                case "event":
                    self.OnEvent(headers);
                break;
            }
        }
    };

    /**
     * Deal with Responses
     */
    this.OnResponse     = function(headers)
    {
        var id  = headers.actionid,
            req = actions[id];

        if(id == loginId && headers.response == "Success")
        {
            loggedIn_ = true;
        }

        if(typeof req.callback == "function")
        {
            req.callback(headers);
        }

        delete actions[id];
    };

    /**
     * Deal with Events
     */
    this.OnEvent        = function(headers)
    {
        if(config.debug == "on")
        {
            sys.puts("DEBUG: Headers");
            sys.puts(JSON.stringify(headers));
        }

        switch(headers.event)
        {
            // New participant
            case "Newchannel":
            if(config.debug == "on")
            {
                sys.puts("DEBUG: Newchannel");
            }

            if(typeof self.participants[headers.uniqueid] == "undefined")
            {
                self.participants[headers.uniqueid] = {id: headers.uniqueid, name: headers.calleridname, number: headers.calleridnum, exten: headers.exten};

                // Catch incoming call
                var inbound = new RegExp("^("+config.inbound.join('|')+")$");

                if(headers.context.match(inbound) && headers.privilege == "call,all" &&
                   ((headers.channelstate == "4" && headers.channelstatedesc == "Ring") ||  // T1
                    (headers.channelstate == "0" && headers.channelstatedesc == "Down")))   // SIP
                {
                    self.emit("incomingcall", self.participants[headers.uniqueid]);
                }

                // Catch outbound
                // Catch internal
            }
            break;

            // Caller ID info
            case "Newcallerid":
                if(typeof self.participants[headers.uniqueid] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Newcallerid");
                    }

                    // Get the Caller ID Number if not set
                    if(typeof self.participants[headers.uniqueid]["number"] == "undefined")
                    {
                        self.participants[headers.uniqueid]["number"] = headers.callerid;
                    }

                    // Get the Caller ID Name
                    if(headers.calleridname[0] != "undefined")
                    {
                        self.participants[headers.uniqueid]["name"] = headers.calleridname;
                    }

                    self.emit("callerid", self.participants[headers.uniqueid]);
                }
            break;

            // Source participant is dialing a destination participant
            case "Dial":
                if(typeof self.participants[headers.uniqueid1] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Dial");
                    }

                    self.participants[headers.srcuniqueid]["with"]  = headers.destuniqueid;
                    self.participants[headers.destuniqueid]["with"] = headers.srcuniqueid;

                    self.emit("dialing", self.participants[headers.srcuniqueid], self.participants[headers.destuniqueid]);
                }
            break;

            // The participants have been connected and voice is now available (1.4)
            /*
            case "Link":
                if(typeof self.participants[headers.uniqueid1] != "undefined")
                {
                    self.emit("callconnected", self.participants[headers.uniqueid1], self.participants[headers.uniqueid2]);
                }
            break;
            */

            // The participants have been connected and voice is now available (1.6+)
            case "Bridge":
                if(typeof self.participants[headers.uniqueid1] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Bridge");
                    }

                    var ext                                    = headers.channel2;
                    ext                                        = ext.split("-");
                    ext                                        = ext[0].split("/");
                    ext                                        = ext[1];
                    self.participants[headers.uniqueid1]['to'] = ext;
                    self.emit("callconnected", self.participants[headers.uniqueid1]);
                }
            break;

            case "Hold":
                // Someone put someone else on hold
                if(typeof self.participants[headers.uniqueid] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Hold");
                    }

                    self.emit("hold", self.participants[headers.uniqueid]);
                }
            break;

            case "Unhold":
                // Someone took someone else off of hold
                if(typeof self.participants[headers.uniqueid] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Hold");
                    }

                    self.emit("unhold", self.participants[headers.uniqueid]);
                }
            break;

            // Call has ended and the participants are disconnected from each other
            case "Unlink":
                if(typeof self.participants[headers.uniqueid] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Disconnected");
                    }

                    self.emit("calldisconnected", self.participants[headers.uniqueid1], self.participants[headers.uniqueid2]);
                }
            break;

            // Fires for each participant and contains the cause for the participant's hangup
            case "Hangup":
                if(typeof self.participants[headers.uniqueid] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Hangup");
                    }

                    self.emit("hangup", self.participants[headers.uniqueid], headers.cause, headers.causetxt);
                }
            break;

            // Call data record. contains a ton of useful info about the call (whether it was successful or not) that recently ended
            case "Cdr":
                if(typeof self.participants[headers.uniqueid] != "undefined")
                {
                    if(config.debug == "on")
                    {
                        sys.puts("DEBUG: Cdr");
                    }


                    var idCaller = headers.uniqueid,
                        idCallee = self.participants[idCaller]["with"],
                        status   = headers.disposition.toLowerCase();

                    // use "callreport" instead of "callrecord" so as not to potentially confuse "record" as in recording the voice(s) call, ala monitoring
                    self.emit("callreport", {
                        caller        : self.participants[idCaller],
                        callee        : self.participants[idCallee],
                        startTime     : headers.starttime,
                        answerTime    : headers.answertime,
                        endTime       : headers.endtime,
                        totalDuration : headers.duration, // in seconds
                        talkDuration  : headers.billableseconds, // in seconds
                        finalStatus   : status
                    });

                    delete self.participants[idCaller];
                    delete self.participants[idCallee];
                }
            break;

            // Ignore theseas they aren"t generally useful for ordinary tasks
            case "Newstate":
            case "Registry":
            case "Newexten":
            break;

            // Everything else
            default:
                //sys.debug("ASTERISK: Got unknown event "" + headers.event + "" with data: " + sys.inspect(headers));
        }
    };

    // Create a connection
    this.connect        = function()
    {
        if(!self.conn || self.conn.readyState == "closed")
        {
            self.conn = net.createConnection(config.port, config.host);

            self.conn.addListener("connect", self.OnConnect);
            //self.conn.addListener("error", self.OnError); // disable for now to get a better idea of source of bugs/errors
            self.conn.addListener("close", self.OnClose);
            self.conn.addListener("end", self.OnEnd);
            self.conn.addListener("data", self.OnData);

            if(config.connect_timeout > 0)
            {
                self.tmoConn = setTimeout(function()
                {
                    self.emit("timeout");
                    self.conn.end();
                }, config.connect_timeout);
            }
        }
    };

    // Login
    this.login          = function(cb)
    {
        if(!loggedIn_ && self.conn.readyState == "open") {
            self.send({
                action   : "login",
                username : config.user,
                secret   : config.password,
                events   : config.events
            }, cb);
        }
    };

    // Disconnect
    this.disconnect     = function()
    {
        if(self.conn.readyState == "open")
        {
            self.conn.end();
        }
    };

    // ??
    this.__defineGetter__("loggedIn", function ()
    {
        return loggedIn_;
    });

    this.setConfig(newconfig);
};

inherits(exports.AsteriskManager, EventEmitter);