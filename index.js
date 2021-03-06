/* jshint -W030, -W069, esversion: 6 */
let WebSocket = require('ws');
let http = require('http');
let url = require('url');
let request = require('request-json');
let nonce = require('nonce')();

let wsc;
let isSocketOpen = false;
let sequence = 0;
let webClient = '';
let apiKey = 'UNCONFIGURED';
let authenticationToken = 'UNCONFIGURED';
let Accessory, Service, Characteristic, UUIDGen;

module.exports = function(homebridge) {
    console.log("homebridge API version: " + homebridge.version);

    // Accessory must be created from PlatformAccessory Constructor
    Accessory = homebridge.platformAccessory;

    // Service and Characteristic are from hap-nodejs
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    // For platform plugin to be considered as dynamic platform plugin,
    // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
    homebridge.registerPlatform("homebridge-eWeLink", "eWeLink", eWeLink, true);

};

// Platform constructor
function eWeLink(log, config, api) {

    if(!config || (!config['authenticationToken'] && ((!config['phoneNumber'] && !config['email']) || !config['password'] || !config['imei']))){
        log("Initialization skipped. Missing configuration data.");
        return;
    }

    if (!config['apiHost']) {
        config['apiHost'] = 'us-api.coolkit.cc:8080';
    }
    if (!config['webSocketApi']) {
        config['webSocketApi'] = 'us-pconnect3.coolkit.cc';
    }

    log("Intialising eWeLink");

    let platform = this;

    this.log = log;
    this.config = config;
    this.accessories = new Map();
    this.authenticationToken = config['authenticationToken'];
    this.devicesFromApi = new Map();
    this.sensorTimers = [];

    if (api) {
        // Save the API object as plugin needs to register new accessory via this object
        this.api = api;

        // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
        // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
        // Or start discover new accessories.


        this.api.on('didFinishLaunching', function() {

            platform.log("A total of [%s] accessories were loaded from the local cache", platform.accessories.size);
            
            this.login(function () {
                
                // Get a list of all devices from the API, and compare it to the list of cached devices.
                // New devices will be added, and devices that exist in the cache but not in the web list
                // will be removed from Homebridge.

                let url = 'https://' + this.config['apiHost'];

                platform.log("Requesting a list of devices from eWeLink HTTPS API at [%s]", url);

                this.webClient = request.createClient(url);

                this.webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
                this.webClient.get('/api/user/device', function(err, res, body) {

                    if (err){
                        platform.log("An error was encountered while requesting a list of devices. Error was [%s]", err);
                        return;
                    } else if (!body || body.hasOwnProperty('error')) {

                        let response = JSON.stringify(body);

                        platform.log("An error was encountered while requesting a list of devices. Response was [%s]", response);

                        if (body && body.error === '401') {
                            platform.log("Verify that you have the correct authenticationToken specified in your configuration. The currently-configured token is [%s]", platform.authenticationToken);
                        }

                        return;
                    }

                    let size = Object.keys(body).length;
                    platform.log("eWeLink HTTPS API reports that there are a total of [%s] devices registered", size);

                    if (size === 0) {
                        platform.log("As there were no devices were found, all devices have been removed from the platorm's cache. Please regiester your devices using the eWeLink app and restart HomeBridge");
                        platform.accessories.clear();
                        platform.api.unregisterPlatformAccessories("homebridge-eWeLink", "eWeLink", platform.accessories);
                        return;
                    }

                    let newDevicesToAdd = new Map();

                    body.forEach((device) => {
                        platform.apiKey = device.apikey;
                        platform.devicesFromApi.set(device.deviceid, device);
                    });

                    // Now we compare the cached devices against the web list
                    platform.log("Evaluating if devices need to be removed...");

                    function checkIfDeviceIsStillRegistered(value, deviceId, map) {

                        let accessory = platform.accessories.get(deviceId);

                        if (platform.devicesFromApi.has(deviceId)) {
                            platform.log('Device [%s] is regeistered with API. Nothing to do.', accessory.displayName);
                        } else {
                            platform.log('Device [%s], ID : [%s] was not present in the response from the API. It will be removed.', accessory.displayName, accessory.UUID);
                            platform.removeAccessory(accessory);
                        }
                    }

                    // If we have devices in our cache, check that they exist in the web response
                    if (platform.accessories.size > 0) {
                        platform.log("Verifying that all cached devices are still registered with the API. Devices that are no longer registered with the API will be removed.");
                        platform.accessories.forEach(checkIfDeviceIsStillRegistered);
                    }

                    platform.log("Evaluating if new devices need to be added...");

                    // Now we compare the cached devices against the web list
                    function checkIfDeviceIsAlreadyConfigured(value, deviceId, map) {

                        if (platform.accessories.has(deviceId)) {

                            platform.log('Device with ID [%s] is already configured. Ensuring that the configuration is current.', deviceId);

                            let accessory = platform.accessories.get(deviceId);
                            let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
                            let switchesAmount = platform.getDeviceChannelCount(deviceInformationFromWebApi);
                            let dimmable = platform.getDeviceDimmable(deviceInformationFromWebApi);

                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, deviceInformationFromWebApi.extra.extra.mac);
                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, deviceInformationFromWebApi.productModel);
                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, deviceInformationFromWebApi.extra.extra.model + ' (' + deviceInformationFromWebApi.uiid + ')');
                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceInformationFromWebApi.params.fwVersion);

                            if(switchesAmount < 1) {

                            } else if(switchesAmount > 1) {
                                platform.log(switchesAmount + " channels device has been set: " + deviceInformationFromWebApi.extra.extra.model + ' uiid: ' + deviceInformationFromWebApi.uiid);
                                platform.updatePowerStateCharacteristic(deviceId, deviceInformationFromWebApi.params.switches);
                            } else  {
                                platform.log("Single channel device has been set: " + deviceInformationFromWebApi.extra.extra.model + ' uiid: ' + deviceInformationFromWebApi.uiid);
                                platform.updatePowerStateCharacteristic(deviceId, deviceInformationFromWebApi.params.switch);
                                if (dimmable) {
                                    platform.log("Dimmable device");
                                    platform.updateBrightnessCharacteristic(deviceId, deviceInformationFromWebApi.params.bright);
                                }
                            }

                        } else {
                            let deviceToAdd = platform.devicesFromApi.get(deviceId);
                            platform.log('Device [%s], ID : [%s] will be added', deviceToAdd.name, deviceId);
                            platform.addAccessory(deviceToAdd);
                        }
                    }

                    // Go through the web response to make sure that all the devices that are in the response do exist in the accessories map
                    if (platform.devicesFromApi.size > 0) {
                        platform.devicesFromApi.forEach(checkIfDeviceIsAlreadyConfigured);
                    }

                    platform.log("API key retrieved from web service is [%s]", platform.apiKey);

                    // We have our devices, now open a connection to the WebSocket API

                    let url = 'wss://' + platform.config['webSocketApi'] + ':8080/api/ws';

                    platform.log("Connecting to the WebSocket API at [%s]", url);

                    platform.wsc = new WebSocketClient();

                    platform.wsc.open(url);

                    platform.wsc.onmessage = function(message) {

                        // Heartbeat response can be safely ignored
                        if (message == 'pong') {
                            return;
                        }

                        platform.log("WebSocket messge received: ", message);

                        let json;
                        try {
                            json = JSON.parse(message);
                        } catch (e) {
                            return;
                        }

                        if (json.hasOwnProperty("action")) {

                            if (json.action === 'update') {

                                platform.log("Update message received for device [%s]", json.deviceid);

                                if (json.hasOwnProperty("params") && json.params.hasOwnProperty("switch")) {
                                    platform.updatePowerStateCharacteristic(json.deviceid, json.params.switch);
                                } else if (json.hasOwnProperty("params") && json.params.hasOwnProperty("switches") && Array.isArray(json.params.switches)) {
                                    platform.updatePowerStateCharacteristic(json.deviceid, json.params.switches);
                                }
                                if (json.hasOwnProperty("params") && json.params.hasOwnProperty("bright")) {
                                    platform.updateBrightnessCharacteristic(json.deviceid, json.params.bright);
                                }

                                if (json.hasOwnProperty("params") && json.params.hasOwnProperty("cmd") && json.params.hasOwnProperty("rfTrig0") && json.params.cmd == "trigger") {
                                    platform.updateSensorStateCharacteristic(json.deviceid, json.params.rfTrig0);
                                }

                            }

                        } else if (json.hasOwnProperty('config') && json.config.hb && json.config.hbInterval) {
                            if (!platform.hbInterval) {
                                platform.hbInterval = setInterval(function () {
                                    platform.wsc.send('ping');
                                }, json.config.hbInterval * 1000);
                            }
                        }

                    };

                    platform.wsc.onopen = function(e) {

                        platform.isSocketOpen = true;

                        // We need to authenticate upon opening the connection

                        let time_stamp = new Date() / 1000;
                        let ts = Math.floor(time_stamp);

                        // Here's the eWeLink payload as discovered via Charles
                        let payload = {};
                        payload.action = "userOnline";
                        payload.userAgent = 'app';
                        payload.version = 6;
                        payload.nonce = '' + nonce();
                        payload.apkVesrion = "1.8";
                        payload.os = 'ios';
                        payload.at = config.authenticationToken;
                        payload.apikey = platform.apiKey;
                        payload.ts = '' + ts;
                        payload.model = 'iPhone10,6';
                        payload.romVersion = '11.1.2';
                        payload.sequence = platform.getSequence();

                        let string = JSON.stringify(payload);

                        platform.log('Sending login request [%s]', string);

                        platform.wsc.send(string);

                    };

                    platform.wsc.onclose = function(e) {
                        platform.log("WebSocket was closed. Reason [%s]", e);
                        platform.isSocketOpen = false;
                        if (platform.hbInterval) {
                            clearInterval(platform.hbInterval);
                            platform.hbInterval = null;
                        }
                    };

                }); // End WebSocket

            }.bind(this)); // End login

        }.bind(this));
    }
}

// Function invoked when homebridge tries to restore cached accessory.
// We update the existing devices as part of didFinishLaunching(), as to avoid an additional call to the the HTTPS API.
eWeLink.prototype.configureAccessory = function(accessory) {

    this.log(accessory.displayName, "Configure Accessory");

    let platform = this;

    var service_switch_1 = accessory.getServiceByUUIDAndSubType(Service.Switch, 'channel-0');

    if (service_switch_1) {
       service_switch_1.getCharacteristic(Characteristic.On)
                .on('set', function(value, callback) {
                    platform.setPowerState(accessory, 0, value, callback);
                })
                .on('get', function(callback) {
                    platform.getPowerState(accessory, 0, callback);
                });
    }

    var service_bulb = accessory.getServiceByUUIDAndSubType(Service.Lightbulb, 'channel-0');

    if (service_bulb) {
       service_bulb.getCharacteristic(Characteristic.On)
                .on('set', function(value, callback) {
                    platform.setPowerState(accessory, 0, value, callback);
                })
                .on('get', function(callback) {
                    platform.getPowerState(accessory, 0, callback);
                });

        characteristic = service_bulb.getCharacteristic(Characteristic.Brightness);
        if (characteristic) {
            characteristic.on('set', function(value, callback) {
                    platform.setBrightness(accessory, "0", value, callback);
                })
                .on('get', function(callback) {
                    platform.getBrightness(accessory, "0", callback);
                }); 
        }
    }

    var service_switch_2 = accessory.getServiceByUUIDAndSubType(Service.Switch, 'channel-1');

    if (service_switch_2) {
       service_switch_2.getCharacteristic(Characteristic.On)
                .on('set', function(value, callback) {
                    platform.setPowerState(accessory, 1, value, callback);
                })
                .on('get', function(callback) {
                    platform.getPowerState(accessory, 1, callback);
                });
    }

    var service_motion_sensor = accessory.getServiceByUUIDAndSubType(Service.MotionSensor, 'channel-0');

    if (service_motion_sensor) {
       service_motion_sensor.getCharacteristic(Characteristic.MotionDetected)
                .on('get', function(callback) {
                    platform.getSensorState(accessory, "0", callback);
                });
    }

    this.accessories.set(accessory.context.deviceId, accessory);

};

// Sample function to show how developer can add accessory dynamically from outside event
eWeLink.prototype.addAccessory = function(device) {

    // Here we need to check if it is currently there
    
    if (this.accessories.get(device.deviceid)) {
        this.log("Not adding [%s] as it already exists in the cache", device.deviceid);
        return;
    }

    let platform = this;
    let channel = 0;

    if (device.type != 10) {
        this.log("A device with an unknown type was returned. It will be skipped.", device.type);
        return;
    }

    try {   
        const status = channel && device.params.switches && device.params.switches[channel-1] ? device.params.switches[channel-1].switch : device.params.switch || "off";
        this.log("Found Accessory with Name : [%s], Manufacturer : [%s], Status : [%s], Is Online : [%s], API Key: [%s] ", device.name + (channel ? ' CH ' + channel : ''), device.productModel, status, device.online, device.apikey);
    } catch (e) {
        this.log("Problem accessory Accessory with Name : [%s], Manufacturer : [%s], Error : [%s], Is Online : [%s], API Key: [%s] ", device.name + (channel ? ' CH ' + channel : ''), device.productModel, e, device.online, device.apikey);
    }

    const accessory = new Accessory(device.name, UUIDGen.generate((device.deviceid).toString()));

    accessory.context.deviceId = device.deviceid;
    accessory.context.apiKey = device.apikey;

    let switchesAmount = platform.getDeviceChannelCount(device);
    let dimmable = platform.getDeviceDimmable(device);
    let rgb = platform.getDeviceRgb(device);
    let isBridge = platform.getDeviceIsBridge(device);

    accessory.context.isBridge = isBridge;
    accessory.context.channels = [];

    accessory.reachable = device.online === 'true';

    if (switchesAmount == 1) {
        if (dimmable) {
            accessory.addService(Service.Lightbulb, device.name, 'channel-0')
                .getCharacteristic(Characteristic.On)
                .on('set', function(value, callback) {
                    platform.setPowerState(accessory, "0", value, callback);
                })
                .on('get', function(callback) {
                    platform.getPowerState(accessory, "0", callback);
                });
            accessory.getService(Service.Lightbulb, device.name, 'channel-0')
                .addCharacteristic(Characteristic.Brightness)
                .on('set', function(value, callback) {
                    platform.setBrightness(accessory, "0", value, callback);
                })
                .on('get', function(callback) {
                    platform.getBrightness(accessory, "0", callback);
                }); 
        } else {
            accessory.addService(Service.Switch, device.name, 'channel-0')
                .getCharacteristic(Characteristic.On)
                .on('set', function(value, callback) {
                    platform.setPowerState(accessory, "0", value, callback);
                })
                .on('get', function(callback) {
                    platform.getPowerState(accessory, "0", callback);
                });
        }
        accessory.context.channels.push(0);
    } else if (switchesAmount == 2) {
        accessory.addService(Service.Switch, device.name + " CH1", 'channel-0')
            .getCharacteristic(Characteristic.On)
            .on('set', function(value, callback) {
                platform.setPowerState(accessory, "0", value, callback);
            })
            .on('get', function(callback) {
                platform.getPowerState(accessory, "0", callback);
            });
        accessory.addService(Service.Switch, device.name + " CH2", 'channel-1')
            .getCharacteristic(Characteristic.On)
            .on('set', function(value, callback) {
                platform.setPowerState(accessory, "1", value, callback);
            })
            .on('get', function(callback) {
                platform.getPowerState(accessory, "1", callback);
            });
            accessory.context.channels.push([0, 1]);
    } else if (switchesAmount > 2) {
        /*for (var switchChannel = 0; switchChannel < switchesAmount; switchChannel++) {
            accessory.addService(Service.Switch, device.name + ' CH' + (switchChannel + 1), 'channel-' + switchChannel)
                .getCharacteristic(Characteristic.On)
                .on('set', function(value, callback) {
                    platform.setPowerState(accessory, new String(switchChannel), value, callback);//channels not supported yet, reference error
                })
                .on('get', function(callback) {
                    platform.getPowerState(accessory, new String(switchChannel), callback);//channels not supported yet, reference error
                });
            accessory.context.channels.push(new String(switchChannel));//channels not supported yet, reference error
        }*/
    } else if (isBridge) {
        //Device is RF Bridge, add motiton sensors (switches not supported yet)
        if (device.hasOwnProperty('params') && device.params.hasOwnProperty('rfList')) {
            for (let i = 0; i < device.params.rfList.length ; i++) {
                if (device.params.rfList[i].hasOwnProperty('rfChl')) {
                    var sensorChannel = device.params.rfList[i].rfChl;
                    accessory.addService(Service.MotionSensor, 'Motion Sensor CH' + sensorChannel, 'channel-' + sensorChannel)
                        .getCharacteristic(Characteristic.MotionDetected)
                        .on('get', function(callback) {
                            platform.getSensorState(accessory, "0", callback);//Channels not supported yet!
                        });    
                }
                accessory.context.channels.push(sensorChannel);
            }
        }
    }

    accessory.on('identify', function(paired, callback) {
        platform.log(accessory.displayName, "Identify not supported");
        callback();
    });

    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, device.extra.extra.mac);
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, device.productModel);
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, device.extra.extra.model);
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Identify, false);
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);

    this.accessories.set(device.deviceid, accessory);

    this.api.registerPlatformAccessories("homebridge-eWeLink",
        "eWeLink", [accessory]);
};

eWeLink.prototype.getSequence = function() {
    let time_stamp = new Date() / 1000;
    this.sequence = Math.floor(time_stamp * 1000);
    return this.sequence;
};

eWeLink.prototype.updatePowerStateCharacteristic = function(deviceId, state) {

    // Used when we receive an update from an external source
    let platform = this;

    let accessory = platform.accessories.get(deviceId);
    let device = platform.devicesFromApi.get(deviceId);
    let switchesAmount = platform.getDeviceChannelCount(device);
    let dimmable = platform.getDeviceDimmable(device);

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    platform.log("Updating recorded Characteristic.On for [%s], to.", accessory.displayName, state);

    if (switchesAmount == 0) {
        //Don't do anything, no switches
    } else if (switchesAmount == 1) {
        var isOn = false;
        if (state == 'on') {
            isOn = true;
        }
        if (dimmable) {
            if (accessory.getService(Service.Lightbulb)) {
                accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.On, isOn);
            }
        } else {
            if (accessory.getService(Service.Switch)) {
                accessory.getService(Service.Switch).updateCharacteristic(Characteristic.On, isOn);
            }
        }
        
    } else if (switchesAmount == 2) {
        state.forEach(function (entry) {
            if (entry.hasOwnProperty('outlet') && entry.hasOwnProperty('switch')) {
                var channel = entry.outlet;
                if (channel < switchesAmount) {
                    var isOn = false;
                    if (entry.switch == 'on') {
                        isOn = true;
                    }
                    var channelString = 'channel-' + channel;
                    var service = accessory.getServiceByUUIDAndSubType(Service.Switch, channelString);
                    if (service) {
                        service.updateCharacteristic(Characteristic.On, isOn);
                    }
                }
            }
        });
    } else {
        //only up to two channel switches supported
    }

};

eWeLink.prototype.updateSensorStateCharacteristic = function(deviceId, state) {

    // Used when we receive an update from an external source
    let platform = this;

    var motion = ((state !== false) ? true : false);

    let accessory = platform.accessories.get(deviceId);
    let device = platform.devicesFromApi.get(deviceId);

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    platform.log("Updating recorded Characteristic.MotionDetected for [%s], to.", accessory.displayName, state);

    if (accessory.getService(Service.MotionSensor)) {
        accessory.getService(Service.MotionSensor).updateCharacteristic(Characteristic.MotionDetected, motion);
    }

    if (motion === true) {
        clearTimeout(platform.sensorTimers[deviceId]);
        platform.sensorTimers[deviceId] = setTimeout(function() {
            platform.updateSensorStateCharacteristic(deviceId, false);
        }, 60000);
    }
};


eWeLink.prototype.getPowerState = function(accessory, channel, callback) {
    let platform = this;

    if (!this.webClient) {
        callback('this.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting power state for [%s] on channel [%s]", accessory.displayName, channel);

    this.webClient.get('/api/user/device', function(err, res, body) {

        if (err){
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Error was [%s]", err);
            return;
        } else if (!body || body.hasOwnProperty('error')) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            if (body.hasOwnProperty('error') && [401, 402].indexOf(parseInt(body.error)) !== -1) {
                platform.relogin();
            }
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            return;
        }

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;
        let switchesAmount = platform.getDeviceChannelCount(platform.devicesFromApi.get(deviceId));

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {

                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                if(switchesAmount < 1) {

                } else if(switchesAmount > 1) {

                    if (device.params.switches[channel].switch === 'on') {
                        accessory.reachable = true;
                        let channelString = parseInt(channel, 10) + 1;
                        platform.log('API reported that [%s CH%s] is On', device.name, channelString);
                        callback(null, 1);
                        return;
                    } else if (device.params.switches[channel].switch === 'off') {
                        accessory.reachable = true;
                        let channelString = parseInt(channel, 10) + 1;
                        platform.log('API reported that [%s CH%s] is Off', device.name, channelString);
                        callback(null, 0);
                        return;
                    } else {
                        accessory.reachable = false;
                        platform.log('API reported an unknown status for device [%s]', accessory.displayName);
                        callback('API returned an unknown status for device ' + accessory.displayName);
                        return;
                    }

                } else {
                    if (device.params.switch === 'on' || device.params.state === 'on') {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] is On', device.name);
                        callback(null, 1);
                        return;
                    } else if (device.params.switch === 'off' || device.params.state === 'off') {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] is Off', device.name);
                        callback(null, 0);
                        return;
                    } else {
                        accessory.reachable = false;
                        platform.log('API reported an unknown status for device [%s]', accessory.displayName);
                        callback('API returned an unknown status for device ' + accessory.displayName);
                        return;
                    }

                }

            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {

            // The device is no longer registered

            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);

        }
    });
};


eWeLink.prototype.getSensorState = function(accessory, channel, callback) {

    let platform = this;

    if (!this.webClient) {
        callback('this.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting power state for [%s] on channel [%s]", accessory.displayName, channel);

    this.webClient.get('/api/user/device', function(err, res, body) {

        if (err){
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Error was [%s]", err);
            return;
        } else if (!body || body.hasOwnProperty('error')) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            if (body.hasOwnProperty('error') && [401, 402].indexOf(parseInt(body.error)) !== -1) {
                platform.relogin();
            }
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            return;
        }

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;
        let switchesAmount = platform.getDeviceChannelCount(platform.devicesFromApi.get(deviceId));

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {

                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                if (device.hasOwnProperty("params") && device.params.hasOwnProperty("cmd") && device.params.hasOwnProperty("rfTrig0") && device.params.cmd == "trigger") {
                    var triggeredTime = new Date(device.params.rfTrig0);
                    var nowTime = new Date();
                    var seconds = (nowTime.getTime() - triggeredTime.getTime()) / 1000;
                    if (seconds < 60) {
                        callback(null, true);
                    } else {
                        callback(null, false);
                    }
                } else {
                    callback(null, false);
                }
            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {

            // The device is no longer registered

            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);

        }
    });
};

eWeLink.prototype.setPowerState = function(accessory, channel, isOn, callback) {

    let platform = this;
    let options = {};
    let deviceId = accessory.context.deviceId;
    options.protocolVersion = 13;

    let targetState = 'off';

    if (isOn) {
        targetState = 'on';
    }

    platform.log("Setting power state to [%s] for device [%s] for channel [%s]", targetState, accessory.displayName, channel);

    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {};
    let switchesAmount = platform.getDeviceChannelCount(platform.devicesFromApi.get(deviceId));

    if (switchesAmount < 1) {

    } else if (switchesAmount > 1) {
        let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
        payload.params.switches = deviceInformationFromWebApi.params.switches;
        payload.params.switches[channel].switch = targetState;
    } else {
        payload.params.switch = targetState;
        payload.params.state = targetState;
    }
    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + deviceId;

    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);

    if (platform.isSocketOpen) {

        setTimeout(function() {
            platform.wsc.send(string);

            // TODO Here we need to wait for the response to the socket

            callback();
        }, 1);

    } else {
        callback('Socket was closed. It will reconnect automatically; please retry your command');
    }

};



eWeLink.prototype.updateBrightnessCharacteristic = function(deviceId, brightness) {

    // Used when we receive an update from an external source
    let platform = this;

    let accessory = platform.accessories.get(deviceId);
    let device = platform.devicesFromApi.get(deviceId);
    let switchesAmount = platform.getDeviceChannelCount(device);

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    platform.log("Updating recorded Characteristic.Brightness for [%s], to. [%s]", accessory.displayName, brightness);

    if (switchesAmount == 1) {
        if (accessory.getService(Service.Lightbulb)) {
            accessory.getService(Service.Lightbulb).updateCharacteristic(Characteristic.Brightness, brightness);
        }
    } else {
        //only single state dimmers supported
    }

};

eWeLink.prototype.getBrightness = function(accessory, channel, callback) {
    let platform = this;

    if (!this.webClient) {
        callback('this.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting brightness for [%s] on channel [%s]", accessory.displayName, channel);

    this.webClient.get('/api/user/device', function(err, res, body) {

        if (err){
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Error was [%s]", err);
            return;
        } else if (!body || body.hasOwnProperty('error')) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            if (body.hasOwnProperty('error') && [401, 402].indexOf(parseInt(body.error)) !== -1) {
                platform.relogin();
            }
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            return;
        }

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;
        let switchesAmount = platform.getDeviceChannelCount(platform.devicesFromApi.get(deviceId));

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {

                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                if(switchesAmount == 1) {
                    if (device.params.bright) {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] is at brightness [%s]', device.name, device.params.bright);
                        callback(null, device.params.bright);
                        return;
                    } else {
                        accessory.reachable = false;
                        platform.log('API reported an unknown status for device [%s]', accessory.displayName);
                        callback('API returned an unknown status for device ' + accessory.displayName);
                        return;
                    }
                } else {
                    //only single channel dimmers
                    callback('only single channel dimmers');
                }

            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {

            // The device is no longer registered

            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);

        }

    });


};

eWeLink.prototype.setBrightness = function(accessory, channel, brightness, callback) {

    let platform = this;
    let options = {};
    let deviceId = accessory.context.deviceId;
    options.protocolVersion = 13;

    platform.log("Setting brightness to [%s] for device [%s] for channel [%s]", brightness, accessory.displayName, channel);

    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {};
    let switchesAmount = platform.getDeviceChannelCount(platform.devicesFromApi.get(deviceId));

    if (switchesAmount == 1) {
        payload.params.bright = brightness;
    } else {
        //only single channel dimmers
    }
    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + deviceId;

    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);

    if (platform.isSocketOpen) {

        setTimeout(function() {
            platform.wsc.send(string);

            // TODO Here we need to wait for the response to the socket

            callback();
        }, 1);

    } else {
        callback('Socket was closed. It will reconnect automatically; please retry your command');
    }

};


// Sample function to show how developer can remove accessory dynamically from outside event
eWeLink.prototype.removeAccessory = function(accessory) {

    this.log('Removing accessory [%s]', accessory.displayName);

    this.accessories.delete(accessory.context.deviceId);

    this.api.unregisterPlatformAccessories('homebridge-eWeLink',
        'eWeLink', [accessory]);
};

eWeLink.prototype.login = function(callback) {
    if (!this.config.phoneNumber && !this.config.email || !this.config.password || !this.config.imei) {
        this.log('phoneNumber / email / password / imei not found in config, skipping login');
        callback();
        return;
    }
    
    var data = {};
    if (this.config.phoneNumber) {
        data.phoneNumber = this.config.phoneNumber;
    } else if (this.config.email) {
        data.email = this.config.email;
    }
    data.password = this.config.password;
    data.version = '6';
    data.ts = '' + Math.floor(new Date().getTime() / 1000);
    data.nonce = '' + nonce();
    data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    data.imei = this.config.imei;
    data.os = 'iOS';
    data.model = 'iPhone10,6';
    data.romVersion = '11.1.2';
    data.appVersion = '3.5.3';
    
    let json = JSON.stringify(data);
    this.log('Sending login request with user credentials: %s', json);
    
    //let appSecret = "248,208,180,108,132,92,172,184,256,152,256,144,48,172,220,56,100,124,144,160,148,88,28,100,120,152,244,244,120,236,164,204";
    //let f = "ab!@#$ijklmcdefghBCWXYZ01234DEFGHnopqrstuvwxyzAIJKLMNOPQRSTUV56789%^&*()";
    //let decrypt = function(r){var n="";return r.split(',').forEach(function(r){var t=parseInt(r)>>2,e=f.charAt(t);n+=e}),n.trim()};
    let decryptedAppSecret = '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM'; //decrypt(appSecret);
    let sign = require('crypto').createHmac('sha256', decryptedAppSecret).update(json).digest('base64');
    this.log('Login signature: %s', sign);
    
    let webClient = request.createClient('https://' + this.config.apiHost);
    webClient.headers['Authorization'] = 'Sign ' + sign;
    webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
    webClient.post('/api/user/login', data , function(err, res, body) {
        if (err) {
            this.log("An error was encountered while logging in. Error was [%s]", err);
            callback();
            return;
        }
        
        // If we receive 301 error, switch to new region and try again
        if (body.hasOwnProperty('error') && body.error == 301 && body.hasOwnProperty('region')) {
            let idx = this.config.apiHost.indexOf('-');
            if (idx == -1) {
                this.log("Received new region [%s]. However we cannot construct the new API host url.", body.region);
                callback();
                return;
            }
            let newApiHost = body.region + this.config.apiHost.substring(idx);
            if (this.config.apiHost != newApiHost) {
                this.log("Received new region [%s], updating API host to [%s].", body.region, newApiHost);
                this.config.apiHost = newApiHost;
                this.login(callback);
                return;
            }
        }
        
        if (!body.at) {
            let response = JSON.stringify(body);
            this.log("Server did not response with an authentication token. Response was [%s]", response);
            callback();
            return;
        }
        
        this.log('Authentication token received [%s]', body.at);
        this.authenticationToken = body.at;
        this.config.authenticationToken = body.at;
        this.webClient = request.createClient('https://' + this.config['apiHost']);
        this.webClient.headers['Authorization'] = 'Bearer ' + body.at;
        
        this.getWebSocketHost(function () {
            callback(body.at);
        }.bind(this));
    }.bind(this));
};

eWeLink.prototype.getWebSocketHost = function (callback) {
    var data = {};
    data.accept = 'mqtt,ws';
    data.version = '6';
    data.ts = '' + Math.floor(new Date().getTime() / 1000);
    data.nonce = '' + nonce();
    data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    data.imei = this.config.imei;
    data.os = 'iOS';
    data.model = 'iPhone10,6';
    data.romVersion = '11.1.2';
    data.appVersion = '3.5.3';
    
    let webClient = request.createClient('https://' + this.config.apiHost.replace('-api', '-disp'));
    webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
    webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
    webClient.post('/dispatch/app', data , function(err, res, body) {
        if (err) {
            this.log("An error was encountered while getting websocket host. Error was [%s]", err);
            callback();
            return;
        }
        
        if (!body.domain) {
            let response = JSON.stringify(body);
            this.log("Server did not response with a websocket host. Response was [%s]", response);
            callback();
            return;
        }
        
        this.log('WebSocket host received [%s]', body.domain);
        this.config['webSocketApi'] = body.domain;
        if (this.wsc) {
            this.wsc.url = 'wss://' + body.domain + ':8080/api/ws';
        }
        callback(body.domain);
    }.bind(this));
};

eWeLink.prototype.relogin = function (callback) {
    let platform = this;
    platform.login(function () {
        // Reconnect websocket
        if (platform.isSocketOpen) {
            platform.wsc.instance.terminate();
            platform.wsc.onclose();
            platform.wsc.reconnect();
        }
        callback && callback();
    });
};

eWeLink.prototype.getDeviceTypeByUiid = function (uiid) {
    const MAPPING = {
        1: "SOCKET",
        2: "SOCKET_2",
        3: "SOCKET_3",
        4: "SOCKET_4",
        5: "SOCKET_POWER",
        6: "SWITCH",
        7: "SWITCH_2",
        8: "SWITCH_3",
        9: "SWITCH_4",
        10: "OSPF",
        11: "CURTAIN",
        12: "EW-RE",
        13: "FIREPLACE",
        14: "SWITCH_CHANGE",
        15: "THERMOSTAT",
        16: "COLD_WARM_LED",
        17: "THREE_GEAR_FAN",
        18: "SENSORS_CENTER",
        19: "HUMIDIFIER",
        22: "RGB_BALL_LIGHT",
        23: "NEST_THERMOSTAT",
        24: "GSM_SOCKET",
        25: "AROMATHERAPY",
        26: "BJ_THERMOSTAT",
        27: "GSM_UNLIMIT_SOCKET",
        28: "RF_BRIDGE",
        29: "GSM_SOCKET_2",
        30: "GSM_SOCKET_3",
        31: "GSM_SOCKET_4",
        32: "POWER_DETECTION_SOCKET",
        33: "LIGHT_BELT",
        34: "FAN_LIGHT",
        35: "EZVIZ_CAMERA",
        36: "SINGLE_CHANNEL_DIMMER_SWITCH",
        38: "HOME_KIT_BRIDGE",
        40: "FUJIN_OPS",
        41: "CUN_YOU_DOOR",
        42: "SMART_BEDSIDE_AND_NEW_RGB_BALL_LIGHT",
        43: "",
        44: "",
        45: "DOWN_CEILING_LIGHT",
        46: "AIR_CLEANER",
        49: "MACHINE_BED",
        51: "COLD_WARM_DESK_LIGHT",
        52: "DOUBLE_COLOR_DEMO_LIGHT",
        53: "ELECTRIC_FAN_WITH_LAMP",
        55: "SWEEPING_ROBOT",
        56: "RGB_BALL_LIGHT_4",
        57: "MONOCHROMATIC_BALL_LIGHT",
        59: "MEARICAMERA",
        1001: "BLADELESS_FAN",
        1002: "NEW_HUMIDIFIER",
        1003: "WARM_AIR_BLOWER"
    };
    return MAPPING[uiid] || "";
};

eWeLink.prototype.getDeviceChannelCountByType = function (deviceType) {
    const DEVICE_CHANNEL_LENGTH = {
        SOCKET: 1,
        SWITCH_CHANGE: 1,
        GSM_UNLIMIT_SOCKET: 1,
        SWITCH: 1,
        THERMOSTAT: 1,
        SOCKET_POWER: 1,
        GSM_SOCKET: 1,
        POWER_DETECTION_SOCKET: 1,
        SOCKET_2: 2,
        GSM_SOCKET_2: 2,
        SWITCH_2: 2,
        SOCKET_3: 3,
        GSM_SOCKET_3: 3,
        SWITCH_3: 3,
        SOCKET_4: 4,
        GSM_SOCKET_4: 4,
        SWITCH_4: 4,
        CUN_YOU_DOOR: 4,
        SINGLE_CHANNEL_DIMMER_SWITCH: 1,
        RGB_BALL_LIGHT: 1
    };
    return DEVICE_CHANNEL_LENGTH[deviceType] || 0;
};

eWeLink.prototype.getDeviceDimmableByType = function (deviceType) {
    const DEVICE_DIMMABLE = {
        SINGLE_CHANNEL_DIMMER_SWITCH: true
    };
    return DEVICE_DIMMABLE[deviceType] || false;
};

eWeLink.prototype.getDeviceRgbByType = function (deviceType) {
    const DEVICE_RGB = {
        RGB_BALL_LIGHT: true
    };
    return DEVICE_RGB[deviceType] || false;
};

eWeLink.prototype.getDeviceIsBridgeByType = function (deviceType) {
    const DEVICE_BRIDGE = {
        RF_BRIDGE: true
    };
    return DEVICE_BRIDGE[deviceType] || false;
};

eWeLink.prototype.getDeviceChannelCount = function (device) {
    let deviceType = this.getDeviceTypeByUiid(device.uiid);
    let channels = this.getDeviceChannelCountByType(deviceType);
    return channels;
};

eWeLink.prototype.getDeviceDimmable = function (device) {
    let deviceType = this.getDeviceTypeByUiid(device.uiid);
    let dimmable = this.getDeviceDimmableByType(deviceType);
    return dimmable;
};

eWeLink.prototype.getDeviceRgb = function (device) {
    let deviceType = this.getDeviceTypeByUiid(device.uiid);
    let rgb = this.getDeviceRgbByType(deviceType);
    return rgb;
};

eWeLink.prototype.getDeviceIsBridge = function (device) {
    let deviceType = this.getDeviceTypeByUiid(device.uiid);
    let bridge = this.getDeviceIsBridgeByType(deviceType);
    return bridge;
};

/* WEB SOCKET STUFF */

function WebSocketClient() {
    this.number = 0; // Message number
    this.autoReconnectInterval = 5 * 1000; // ms
    this.pendingReconnect = false;
}
WebSocketClient.prototype.open = function(url) {
    this.url = url;
    this.instance = new WebSocket(this.url);
    this.instance.on('open', () => {
        this.onopen();
    });

    this.instance.on('message', (data, flags) => {
        this.number++;
        this.onmessage(data, flags, this.number);
    });

    this.instance.on('close', (e) => {
        switch (e) {
            case 1000: // CLOSE_NORMAL
                // console.log("WebSocket: closed");
                break;
            default: // Abnormal closure
                this.reconnect(e);
                break;
        }
        this.onclose(e);
    });
    this.instance.on('error', (e) => {
        switch (e.code) {
            case 'ECONNREFUSED':
                this.reconnect(e);
                break;
            default:
                this.onerror(e);
                break;
        }
    });
};
WebSocketClient.prototype.send = function(data, option) {
    try {
        this.instance.send(data, option);
    } catch (e) {
        this.instance.emit('error', e);
    }
};
WebSocketClient.prototype.reconnect = function(e) {
    // console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);

    if (this.pendingReconnect) return;
    this.pendingReconnect = true;

    this.instance.removeAllListeners();

    let platform = this;
    setTimeout(function() {
        platform.pendingReconnect = false;
        console.log("WebSocketClient: reconnecting...");
        platform.open(platform.url);
    }, this.autoReconnectInterval);
};
WebSocketClient.prototype.onopen = function(e) {
    // console.log("WebSocketClient: open", arguments);
};
WebSocketClient.prototype.onmessage = function(data, flags, number) {
    // console.log("WebSocketClient: message", arguments);
};
WebSocketClient.prototype.onerror = function(e) {
    console.log("WebSocketClient: error", arguments);
};
WebSocketClient.prototype.onclose = function(e) {
    // console.log("WebSocketClient: closed", arguments);
};
