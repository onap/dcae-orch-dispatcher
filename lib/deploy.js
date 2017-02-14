/*
Copyright(c) 2017 AT&T Intellectual Property. All rights reserved. 

Licensed under the Apache License, Version 2.0 (the "License"); 
you may not use this file except in compliance with the License.

You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, 
software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. 
See the License for the specific language governing permissions and limitations under the License.
*/

"use strict";

/* Deploy and undeploy using Cloudify blueprints */

const config = process.mainModule.exports.config;

/* Set delays between steps */
const DELAY_INSTALL_WORKFLOW = 30000;
const DELAY_RETRIEVE_OUTPUTS = 5000;
const DELAY_DELETE_DEPLOYMENT = 30000;
const DELAY_DELETE_BLUEPRINT = 10000;

/* Set up the Cloudify low-level interface library */
var cfy = require("./cloudify.js");
/* Set config for deploy module */
cfy.setAPIAddress(config.cloudify.url);
cfy.setCredentials(config.cloudify.user, config.cloudify.password);
cfy.setLogger(config.logSource);

/* Set up logging */
var logger = config.logSource.getLogger("deploy");

// Try to parse a string as JSON
var parseContent = function(input) {
	var res = {json: false, content: input};
	try {
		var parsed = JSON.parse(input);
		res.json = true;
		res.content = parsed;
	}
	catch (pe) {
		// Do nothing, just indicate it's not JSON and return content as is
	}
	return res;
};

// create a normalized representation of errors, whether they're a node.js Error or a Cloudify API error
var normalizeError = function (err) {
	var e = {};
	if (err instanceof Error) {
		e.message = err.message;
		if (err.code) {
			e.code = err.code;
		}
		if (err.status) {
			e.status = err.status;
		}
	}
	else {
		// Try to populate error with information from a Cloudify API error
		// We expect to see err.body, which is a stringified JSON object
		// We can parse it and extract message and error_code
		e.message = "unknown API error";
		e.code = "UNKNOWN";
		if (err.status) {
			e.status = err.status;
		}
		if (err.body) {
			var p = parseContent(err.body);
			if (p.json) {
				e.message =  p.content.message ? p.content.message : "unknown API error";
				e.code = p.content.error_code ? p.content.error_code : "UNKNOWN";
			}
			else {
				// if there's a body and we can't parse it just attach it as the message
				e.message = err.body;
			}
		}
	}
	
	return e;
};

// Augment the raw outputs from a deployment with the descriptions from the blueprint
var annotateOutputs = function (id, rawOutputs) {
	return new Promise(function(resolve, reject) {
		
		var outItems = Object.keys(rawOutputs);
		
		if (outItems.length < 1) {
			// No output items, so obviously no descriptions, just return empty object
			resolve({});
		}
		else {
			// Call Cloudify to get the descriptions
			cfy.getOutputDescriptions(id)
			.then(function(res) {
				// Assemble an outputs object with values from raw output and descriptions just obtained
				var p = parseContent(res.body);
				if (p.json && p.content.outputs) {
					var outs = {};
					outItems.forEach(function(i) {
						outs[i] = {value: rawOutputs[i]};
						if (p.content.outputs[i] && p.content.outputs[i].description) {
							outs[i].description = p.content.outputs[i].description;
						}					
					});
					resolve(outs);
				}
				else {
					reject({code: "API_INVALID_RESPONSE", message: "Invalid response for output descriptions query"});
				}			
			});
		}
		
	});
};

// Delay function--returns a promise that's resolved after 'dtime' milliseconds.`
var delay = function(dtime) {
	return new Promise(function(resolve, reject){
		setTimeout(resolve, dtime);
	});
};

// Go through the Cloudify API call sequence to do a deployment
exports.deployBlueprint = function(id, blueprint, inputs) {

	logger.debug("deploymentId: " + id + " starting blueprint upload");
	// Upload blueprint
	return cfy.uploadBlueprint(id, blueprint)
	.then (function(result) {
		logger.debug("deploymentId: " + id + " blueprint uploaded");
		// Create deployment
		return cfy.createDeployment(id, id, inputs);	
	})
	.then(function(result){
		logger.debug("deploymentId: " + id + " deployment created");
		// Execute the install workflow
		return delay(DELAY_INSTALL_WORKFLOW).then(function(){ return cfy.executeWorkflow(id, 'install');});
	})
	.then(function(result) {
		logger.debug("deploymentId: " + id + " install workflow successfully executed");
		// Retrieve the outputs from the deployment, as specified in the blueprint
		return delay(DELAY_RETRIEVE_OUTPUTS).then(function() { return cfy.getOutputs(id); });
	})
	.then(function(result) {
	    // We have the raw outputs from the deployment but not annotated with the descriptions
		var rawOutputs = {};
		if (result.body) {
			var p = parseContent(result.body);
			if (p.json) {
				if (p.content.outputs) {
					rawOutputs = p.content.outputs;
				}
			}	
		}
		logger.debug("output retrieval result for " + id + ": " + JSON.stringify(result));
		logger.info("deploymentId " + id + " successfully deployed");
		return annotateOutputs(id, rawOutputs);
	})
	.catch(function(err) {
		throw normalizeError(err);
	});
};

// Go through the Cloudify API call sequence to do an undeployment of a previously deployed blueprint
exports.undeployDeployment = function(id) {
	logger.debug("deploymentId: " + id + " starting uninstall workflow");
	// Run uninstall workflow
	return cfy.executeWorkflow(id, 'uninstall', 0)
	.then (function(result){
		logger.debug("deploymentId: " + id + " uninstall workflow completed");
		// Delete the deployment
		return delay(DELAY_DELETE_DEPLOYMENT).then(function() {return cfy.deleteDeployment(id);});
	})
	.then (function(result){
		logger.debug("deploymentId: " + id + " deployment deleted");
		// Delete the blueprint
		return delay(DELAY_DELETE_BLUEPRINT).then(function() {return cfy.deleteBlueprint(id);});
	})
	.then (function(result){
		logger.info("deploymentId: " + id + " successfully undeployed");
		return result;
	})
	.catch (function(err){
		throw normalizeError(err);
	});
};