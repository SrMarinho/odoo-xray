// Service-worker composition root. Domain validation and transport live in
// core.js so this entry point only wires browser adapters.
if (typeof OdooXray === 'undefined') importScripts('core.js');

const xrayRequestValidator = new OdooXray.RequestValidator(chrome.runtime.id);
const xrayLocalGateway = new OdooXray.LocalGateway(chrome.runtime, fetch);
const xrayBackground = new OdooXray.BackgroundController({
  runtime: chrome.runtime,
  storage: chrome.storage,
  gateway: xrayLocalGateway,
  validator: xrayRequestValidator,
});
xrayBackground.start();

// Compatibility facades used by focused tests and debugging snippets.
const xrayAllowedSender = (sender) => xrayRequestValidator.allowsSender(sender);
const xrayValidOpenMessage = (message) => xrayRequestValidator.isOpen(message);
const xrayValidLookup = (message) => xrayRequestValidator.isLookup(message);
const xraySendLocal = (request, respond) => xrayLocalGateway.send(request, respond);
