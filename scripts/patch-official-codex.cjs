'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const extension = process.argv[2];
if (!extension) { throw new Error('Passa la cartella dell’estensione ufficiale inclusa.'); }
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8'));
if (manifest.publisher !== 'openai' || manifest.name !== 'chatgpt' || manifest.version !== '26.1007.21434') { throw new Error('Versione Codex non verificata: patch non applicata.'); }
const htmlPath = path.join(extension, 'webview', 'index.html');
const hostPath = path.join(extension, 'out', 'extension.js');
const backupPath = hostPath + '.zilpio-original';
if (!fs.existsSync(backupPath)) { fs.copyFileSync(hostPath, backupPath); }
let host = fs.readFileSync(backupPath, 'utf8');
function replaceOnce(from, to) {
	if (host.split(from).length !== 2) { throw new Error('Host Codex non riconosciuto: ' + from.slice(0, 70)); }
	host = host.replace(from, to);
}
replaceOnce('["-c","features.code_mode_host=true","app-server","--analytics-default-enabled"]', '["-c","features.code_mode_host=true","-c",\'cli_auth_credentials_store="ephemeral"\',"app-server","--analytics-default-enabled"]');
replaceOnce('case"ready":break;case"persisted-atom-sync-request":', 'case"zilpio-models":case"zilpio-profiles":{this.zilpioProfiles??=require("./zilpio-profile-host/official-profiles.js").create(this,(id,method,params)=>this.codexMcpConnection.sendRequest(IR,id,method,params),()=>aF(this.extensionUri));await (r.type==="zilpio-models"?this.zilpioProfiles.handleModels(e,r):this.zilpioProfiles.handle(e,r));break}case"ready":break;case"persisted-atom-sync-request":');
replaceOnce('deliverMcpResponseToOrigin(e){let r=', 'deliverMcpResponseToOrigin(e){if(this.zilpioProfiles?.receive(e))return;let r=');
replaceOnce('async getWebviewContent(e){return this.getWebviewContentProduction(e)}', 'async getWebviewContent(e){this.zilpioProfiles??=require("./zilpio-profile-host/official-profiles.js").create(this,(id,method,params)=>this.codexMcpConnection.sendRequest(IR,id,method,params),()=>aF(this.extensionUri));await this.zilpioProfiles.bootstrap();return this.zilpioProfiles.startupHtml(await this.getWebviewContentProduction(e))}');
replaceOnce('onRawNotification:F=>{let{method:V,params:J}=F;', 'onRawNotification:F=>{this.zilpioProfiles?.notification(F.method,F.params);let{method:V,params:J}=F;');
replaceOnce('onRequest:F=>{this.broadcastToAllViews({type:"mcp-request"', 'onRequest:F=>{if(this.zilpioProfiles?.handleServerRequest(F,(id,result)=>this.codexMcpConnection.sendResponse(id,result)))return;this.broadcastToAllViews({type:"mcp-request"');
replaceOnce('onRequestDelivery:F=>{let V=String(F.delivery.requestId),', 'onRequestDelivery:F=>{if(F.type==="failed"&&this.zilpioProfiles?.receive({id:F.delivery.requestId,error:{message:F.message}}))return;let V=String(F.delivery.requestId),');
replaceOnce('case"mcp-request":{if(SK(r.request))', 'case"mcp-request":{if(r.request.method==="turn/start"&&this.zilpioProfiles&&(this.zilpioProfiles.switching||!this.zilpioProfiles.current)){this.postMessageToWebview(e,{type:"mcp-response",hostId:r.hostId,message:{id:r.request.id,error:{code:-32000,message:"Seleziona un account e attendi che il cambio sia completato."}}});break}if(SK(r.request))');
replaceOnce('case"zilpio-models":case"zilpio-profiles":{', 'case"zilpio-environments":{this.zilpioEnvironments??=require("./zilpio-profile-host/environments.js").create(this,this.zilpioProfiles);await this.zilpioEnvironments.handle(e,r);break}case"zilpio-models":case"zilpio-profiles":{');
replaceOnce('case"zilpio-environments":{', 'case"zilpio-agents":{await this.zilpioProfiles.agents.handle(e,r);break}case"zilpio-environments":{');
replaceOnce('if(r.request.method==="turn/start"&&this.zilpioProfiles&&(this.zilpioProfiles.switching||!this.zilpioProfiles.current))', 'if(r.request.method==="turn/start"&&(process.env.ZILPIO_ENVIRONMENT_ERROR||this.zilpioProfiles&&(this.zilpioProfiles.switching||!this.zilpioProfiles.current)))');
replaceOnce('message:"Seleziona un account e attendi che il cambio sia completato."', 'message:process.env.ZILPIO_ENVIRONMENT_ERROR||"Seleziona un account e attendi che il cambio sia completato."');
replaceOnce('break}if(SK(r.request))', 'break}if(r.request.method==="turn/start"&&this.zilpioProfiles)this.zilpioProfiles.pendingTurnStarts.set(String(r.request.id),r.request.params.threadId);if(SK(r.request))');
replaceOnce('this.zilpioProfiles.pendingTurnStarts.set(String(r.request.id),r.request.params.threadId);if(SK(r.request))', 'this.zilpioProfiles.pendingTurnStarts.set(String(r.request.id),r.request.params.threadId);if(r.request.method==="turn/start"&&this.zilpioProfiles){let error;try{if(!await this.zilpioProfiles.confirmTurn(r.request.params))error="Invio annullato."}catch(cause){error=cause.message||"Conferma invio non riuscita."}if(error){this.zilpioProfiles.pendingTurnStarts.delete(String(r.request.id));this.postMessageToWebview(e,{type:"mcp-response",hostId:r.hostId,message:{id:r.request.id,error:{code:-32000,message:error}}});break}}if(SK(r.request))');
replaceOnce('break}}if(SK(r.request))', 'break}this.zilpioProfiles.trackPrompt(r.request.id,r.request.params)}if(SK(r.request))');
replaceOnce('this.codexMcpConnection.sendRequest(IR,String(n),o,i,r.retainResponse)', 'this.codexMcpConnection.sendRequest(IR,String(n),o,i,r.retainResponse||o==="turn/start")');
replaceOnce('this.codexMcpConnection.sendRequest(IR,String(n),o,i,r.retainResponse||o==="turn/start")', 'this.codexMcpConnection.sendRequest(IR,String(n),o,await this.zilpioProfiles.agents.prepareRequest(o,i,String(n)),r.retainResponse||o==="turn/start"||o==="thread/start"||o==="thread/fork")');
replaceOnce('this.codexMcpConnection.prewarmThreadStart(IR,String(n),o,r.retainResponse)', 'this.codexMcpConnection.prewarmThreadStart(IR,String(n),await this.zilpioProfiles.agents.prepareRequest("thread/start",o,String(n)),true)');
replaceOnce('onFatalError:(F,V)=>{this.logger.error("Fatal error"', 'onFatalError:(F,V)=>{this.zilpioProfiles?.resetActivity();this.logger.error("Fatal error"');
host = 'try{require("./zilpio-profile-host/environments.js").applyEnvironment(process.env,require("node:os").homedir(),require("vscode").workspace.workspaceFolders?.[0]?.uri.fsPath);delete process.env.ZILPIO_ENVIRONMENT_ERROR}catch(error){process.env.ZILPIO_ENVIRONMENT_ERROR=error.message}\n' + host;
const hostFiles = path.join(extension, 'out', 'zilpio-profile-host');
replaceOnce('if(!r.replaceCurrentEditor){je.commands.executeCommand("vscode.open",n);break}', 'if(!r.replaceCurrentEditor){await je.commands.executeCommand("vscode.openWith",n,t.customEditorViewType,{preview:!1});break}');
fs.mkdirSync(hostFiles, { recursive: true });
for (const file of ['official-profiles.js', 'startup-state.js', 'agents.js', 'agents-mcp.js', 'environments.js', 'workspaces.js', 'model-settings.js', 'profiles.js', 'profiles.example.json', 'backend.js', 'rpc.js', 'account-auth.js']) { fs.copyFileSync(path.join(root, 'extensions/zilpio-codex', file), path.join(hostFiles, file)); }
const localProfiles = path.join(root, 'extensions/zilpio-codex/profiles.json');
if (fs.existsSync(localProfiles)) { fs.copyFileSync(localProfiles, path.join(hostFiles, 'profiles.json')); }
fs.writeFileSync(hostPath, host);
const modelChunkPath = path.join(extension, 'webview/assets/app-initial-c014f9ee4429.js');
const modelBackupPath = modelChunkPath + '.zilpio-original';
if (!fs.existsSync(modelBackupPath)) { fs.copyFileSync(modelChunkPath, modelBackupPath); }
let modelChunk = fs.readFileSync(modelBackupPath, 'utf8');
for (const [from, to] of [
	['queryFn:({queryKey:e})=>{let t=d.getQueryData(e)', 'queryFn:({queryKey:e})=>{window.zilpioRefreshModels=()=>d.invalidateQueries({queryKey:g});let t=d.getQueryData(e)'],
	['select:({data:n})=>Cbe({additionalAvailableModels:new Set(e)', 'select:({data:n})=>window.zilpioFilterModels(n,Cbe({additionalAvailableModels:new Set(e)'],
	['models:n,useHiddenModels:v.useHiddenModels})', 'models:n,useHiddenModels:v.useHiddenModels}))'],
	['Bp(f,i).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:s},{priority:t})', 'Bp(f,i).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:s},{priority:t}).then(result=>({...result,zilpioSettingsRevision:window.zilpioModelsRevision??0}))'],
	['...$e,titleSuffix:Jt,onContextMenu:Yt,onFilesDropped:Xt', '...$e,dataAttributes:{...$e.dataAttributes,"data-zilpio-thread":r,"data-zilpio-host":te},titleSuffix:Jt,onContextMenu:Yt,onFilesDropped:Xt'],
	['let Lt=Nv(It),Rt=', 'let Lt=Nv((...args)=>Promise.resolve(It(...args)).then(items=>window.zilpioAgents?.menu(r,ne,items)??items)),Rt='],
	['variant:z,onContextMenu:A,onClick:jn,onFileDrop:Pn', 'variant:z,onContextMenu:A??(event=>window.zilpioAgents?.context(event,r,it)),onClick:jn,onFileDrop:Pn'],
	['hoverCardSideOffset:Hn,dataAttributes:Un,primaryAction:Wn', 'hoverCardSideOffset:Hn,dataAttributes:(window.zilpioAgents?.registerChat(r,it,zn??Rn),{...Un,"data-zilpio-thread":r,"data-zilpio-host":it??"local"}),primaryAction:Wn'],
	['if(g){let e;n[7]===x?', 'x=window.zilpioStartupModel(x,r==null);if(g){let e;n[7]===x?'],
	['C=async(e,t,n)=>{yMn(l,r,e);', 'C=async(e,t,n)=>{window.zilpioModelSelected();yMn(l,r,e);'],
	['p!=null&&(L=p.serviceTier),A=FBe(', 'p!=null&&(L=p.serviceTier),L=window.zilpioStartupTier(L,e==null),A=FBe('],
	['f=async(e,t)=>{if(!ZZe(e,d))return!1;', 'f=async(e,t)=>{if(!ZZe(e,d))return!1;window.zilpioTierSelected();']
]) {
	if (modelChunk.split(from).length !== 2) { throw new Error('Selettore modelli Codex non riconosciuto: ' + from); }
	modelChunk = modelChunk.replace(from, to);
}
fs.writeFileSync(modelChunkPath, modelChunk);
let html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes('zilpio-official-controls')) {
	const marker = '<script type="module"';
	if (!html.includes(marker)) { throw new Error('Entrypoint Codex non riconosciuto.'); }
	html = html.replace(marker, '<link id="zilpio-official-controls" rel="stylesheet" href="./assets/zilpio-official-usage.css">\n<script src="./assets/zilpio-official-usage.js"></script>\n' + marker);
}
if (!html.includes('zilpio-model-settings-ui.js')) {
	html = html.replace('<script src="./assets/zilpio-official-usage.js">', '<script src="./assets/zilpio-model-settings-ui.js"></script>\n<script src="./assets/zilpio-official-usage.js">');
}
fs.copyFileSync(path.join(root, 'extensions/zilpio-codex/media/model-settings-ui.js'), path.join(extension, 'webview/assets/zilpio-model-settings-ui.js'));
if (!html.includes('zilpio-environments-ui.js')) {
	html = html.replace('<script src="./assets/zilpio-official-usage.js">', '<script src="./assets/zilpio-environments-ui.js"></script>\n<script src="./assets/zilpio-official-usage.js">');
}
fs.copyFileSync(path.join(root, 'extensions/zilpio-codex/media/environments-ui.js'), path.join(extension, 'webview/assets/zilpio-environments-ui.js'));
if (!html.includes('zilpio-agents-ui.js')) {
	html = html.replace('<script src="./assets/zilpio-official-usage.js">', '<link rel="stylesheet" href="./assets/zilpio-agents.css">\n<script src="./assets/zilpio-agents-ui.js"></script>\n<script src="./assets/zilpio-official-usage.js">');
}
fs.copyFileSync(path.join(root, 'extensions/zilpio-codex/media/agents-ui.js'), path.join(extension, 'webview/assets/zilpio-agents-ui.js'));
fs.copyFileSync(path.join(root, 'extensions/zilpio-codex/media/agents.css'), path.join(extension, 'webview/assets/zilpio-agents.css'));
for (const ext of ['js', 'css']) {
	fs.copyFileSync(path.join(root, 'extensions/zilpio-codex/media', `official-usage.${ext}`), path.join(extension, 'webview/assets', `zilpio-official-usage.${ext}`));
}
fs.writeFileSync(htmlPath, html);
// Keep the packaged preview's webview drag bridge aligned with the source build.
const dragBridgePath = path.resolve(extension, '../../out/vs/workbench/contrib/webview/browser/pre/index.html');
const dragBridgeBackup = dragBridgePath + '.zilpio-drag-original';
if (!fs.existsSync(dragBridgeBackup)) { fs.copyFileSync(dragBridgePath, dragBridgeBackup); }
const dragBridgeOriginal = fs.readFileSync(dragBridgeBackup, 'utf8');
const dragBridgeSource = fs.readFileSync(path.join(root, 'src/vs/workbench/contrib/webview/browser/pre/index.html'), 'utf8');
const dragStart = '\t\tfunction handleInnerDragStartEvent(', dragEnd = '\t\tfunction handleInnerDragEvent(';
const originalStart = dragBridgeOriginal.indexOf(dragStart), originalEnd = dragBridgeOriginal.indexOf(dragEnd, originalStart);
const sourceStart = dragBridgeSource.indexOf('\t\tfunction handleInnerEditorDragStartEvent('), sourceEnd = dragBridgeSource.indexOf(dragEnd, sourceStart);
if ([originalStart, originalEnd, sourceStart, sourceEnd].some(index => index < 0)) { throw new Error('Ponte trascinamento webview non riconosciuto.'); }
let dragBridge = dragBridgeOriginal.slice(0, originalStart) + dragBridgeSource.slice(sourceStart, sourceEnd) + dragBridgeOriginal.slice(originalEnd);
for (const target of ['window', 'contentWindow']) {
	const listener = `${target}.addEventListener('dragenter', handleInnerDragStartEvent);`;
	if (dragBridge.split(listener).length !== 2) { throw new Error('Listener trascinamento webview non riconosciuto.'); }
	dragBridge = dragBridge.replace(listener, `${listener}\n${target}.addEventListener('dragenter', handleInnerEditorDragStartEvent, true);`);
}
const dragScript = dragBridge.match(/<script async type="module">([\s\S]*?)<\/script>/);
if (!dragScript) { throw new Error('Script webview non riconosciuto.'); }
const dragScriptHash = require('node:crypto').createHash('sha256').update(dragScript[1].replace(/\r\n/g, '\n')).digest('base64');
dragBridge = dragBridge.replace(/script-src 'sha256-[^']+'/, `script-src 'sha256-${dragScriptHash}'`);
fs.writeFileSync(dragBridgePath, dragBridge);
console.log('Controlli Zilpio applicati al pannello ufficiale Codex.');
