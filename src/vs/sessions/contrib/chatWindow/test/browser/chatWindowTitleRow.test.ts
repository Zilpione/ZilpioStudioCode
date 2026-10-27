/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { $, append } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../../workbench/common/editor.js';
import { IAuxiliaryWindowService } from '../../../../../workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { GroupDirection } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { createEditorParts, registerTestEditor, TestFileEditorInput, workbenchInstantiationService } from '../../../../../workbench/test/browser/workbenchTestServices.js';
import { ISessionScope } from '../../../../services/sessions/browser/sessionScope.js';
import { createChatWindowEditorArea, createChatWindowServices, reserveChatWindowControls } from '../../browser/chatWindowService.js';
import '../../browser/media/chatWindow.css';

suite('Chat window title row', () => {

	const disposables = new DisposableStore();

	teardown(() => {
		disposables.clear();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	for (const showTabs of ['multiple', 'single'] as const) {
		test(`the top row of the editor area leaves room at the top right for the window controls where they are there (Windows, Linux), its toolbar left of them, and none where they are not (macOS) (tabs: ${showTabs})`, async () => {
			const configurationService = new TestConfigurationService({ 'workbench.editor.showTabs': showTabs });
			const instantiationService = workbenchInstantiationService({ contextKeyService: () => disposables.add(new ContextKeyService(configurationService)) }, disposables);
			instantiationService.stub(IConfigurationService, configurationService);
			disposables.add(registerTestEditor('chatWindowTitleRowEditor', [new SyncDescriptor(TestFileEditorInput)], 'chatWindowTitleRowInput'));
			instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
			instantiationService.stub(IAuxiliaryWindowService, new class extends mock<IAuxiliaryWindowService>() { override getWindow() { return undefined; } }());
			const parts = await createEditorParts(instantiationService, disposables);
			// The grid's host while the header is above the chat's column only.
			const root = append(mainWindow.document.body, $('.monaco-workbench'));
			disposables.add({ dispose: () => root.remove() });
			const host = append(root, $('.chat-window-host.chat-window-header-chat-column'));
			const container = append(host, $('div'));
			container.style.cssText = 'position: absolute; top: 0; left: 0; width: 720px; height: 400px;';
			const scope: ISessionScope = { _serviceBrand: undefined, session: constObservable(undefined) };
			const editorArea = createChatWindowEditorArea(parts, container, createChatWindowServices(scope));
			disposables.add({ dispose: () => editorArea.close() });
			editorArea.layout(720, 400, 0, 0);
			await editorArea.activeGroup.openEditor(disposables.add(new TestFileEditorInput(URI.file('/left'), 'chatWindowTitleRowInput')), { pinned: true });
			const element = editorArea.element as HTMLElement;
			const read = () => Array.from(element.querySelectorAll<HTMLElement>('.editor-group-container')).map(group => {
				const title = Array.from(group.children).find(child => child.classList.contains('title') && child.getBoundingClientRect().height > 0) as HTMLElement | undefined;
				// The row of the tabs, first in the title.
				const row = title?.firstElementChild as HTMLElement | undefined;
				return { reserves: group.classList.contains('chat-window-reserves-controls'), padding: row ? mainWindow.getComputedStyle(row).paddingRight : 'none', drag: title ? mainWindow.getComputedStyle(title).getPropertyValue('-webkit-app-region') : 'none' };
			});

			const windows = { rowHeight: reserveChatWindowControls(element, 138) > 0, groups: read() };
			// Split to the right: the group at the top right leaves the room.
			const right = editorArea.addGroup(editorArea.activeGroup, GroupDirection.RIGHT);
			await right.openEditor(disposables.add(new TestFileEditorInput(URI.file('/right'), 'chatWindowTitleRowInput')), { pinned: true });
			editorArea.layout(720, 400, 0, 0);
			reserveChatWindowControls(element, 138);
			const split = read();
			reserveChatWindowControls(element, 0);
			const macOS = read();

			assert.deepStrictEqual({ windows, split, macOS }, {
				windows: { rowHeight: true, groups: [{ reserves: true, padding: '138px', drag: 'drag' }] },
				split: [{ reserves: false, padding: '0px', drag: 'drag' }, { reserves: true, padding: '138px', drag: 'drag' }],
				macOS: [{ reserves: false, padding: '0px', drag: 'drag' }, { reserves: false, padding: '0px', drag: 'drag' }],
			});
		});
	}
});
