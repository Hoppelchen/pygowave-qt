/*
 * This file is part of the PyGoWave Desktop Client
 *
 * Copyright (C) 2009 Patrick Schneider <patrick.p2k.schneider@googlemail.com>
 *
 * This program is free software: you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation, either version 3 of
 * the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this program; see the file COPYING.  If not,
 * see <http://www.gnu.org/licenses/>.
 */

/**@scope pygowave*/
window.pygowave = $defined(window.pygowave) ? window.pygowave : new Hash(); 

pygowave.view = $defined(pygowave.view) ? pygowave.view : new Hash();

/**
 * PyGoWave's Blip Editor a.k.a. "The Hardest Part(tm)".
 * 
 * @module pygowave.view.blip_editor
 */
(function () {
	/* Imports */
	var Widget = pygowave.view.Widget;
	var Selection = pygowave.view.Selection;
	var GadgetElementWidget = pygowave.view.GadgetElementWidget;
	var ParticipantWidget = pygowave.view.ParticipantWidget;
	
	/**
	 * An editable div which generates events for the controller and is able to
	 * process model changes. Inspired by MooEditable.
	 * 
	 * @class {private} pygowave.view.BlipEditorWidget
	 * @extends pygowave.view.Widget
	 */
	var BlipEditorWidget = new Class({
		Extends: Widget,
		
		/**
		 * Fired if the currently selected text range changed (mainly for
		 * debugging purposes).
		 *
		 * @event onCurrentTextRangeChanged
		 * @param {int} start
		 * @param {int} end
		 */
		
		/**
		 * Fired if Blip editing was started.
		 *
		 * @event onBlipEditing
		 * @param {String} blipId
		 */
		
		/**
		 * Fired if Blip editing was finished.
		 *
		 * @event onBlipDone
		 * @param {String} blipId
		 */
		
		/**
		 * Called on instantiation.
		 * @constructor {public} initialize
		 * @param {WaveView} view A reference back to the main view
		 * @param {pygowave.model.Blip} blip Blip to be rendered
		 * @param {Element} parentElement Parent DOM element to insert the widget
		 * @param {String} where Where to inject the widget relative to the
		 *        parent element. Can be 'top', 'bottom', 'after', or 'before'.
		 */
		initialize: function (view, blip, parentElement, where) {
			this._view = view;
			this._blip = blip;
			this._lastRange = null;
			this._lastValidRange = null;
			this._lastContent = "";
			this._errDiv = null;
			this._firstKeyPress = false;
			this._editing = false;
			this._contributorViewWidgets = new Array();
			this._contributorObjects = new Hash();
			
			var contentElement = new Element('div', {
				'class': 'blip_editor_widget',
				'spellcheck': 'false'
			});
			
			this._onInsertedText = this._onInsertedText.bind(this);
			this._onDeletedText = this._onDeletedText.bind(this);
			this._onInsertedElement = this._onInsertedElement.bind(this);
			this._onDeletedElement = this._onDeletedElement.bind(this);
			this._onKeyDown = this._onKeyDown.bind(this);
			this._onKeyPress = this._onKeyPress.bind(this);
			this._onKeyUp = this._onKeyUp.bind(this);
			this._onContextMenu = this._onContextMenu.bind(this);
			this._onMouseUp = this._onMouseUp.bind(this);
			this._onMouseDown = this._onMouseDown.bind(this);
			this._onOutOfSync = this._onOutOfSync.bind(this);
			this._onLastModifiedChanged = this._onLastModifiedChanged.bind(this);
			this._onContributorAdded = this._onContributorAdded.bind(this);
			this._updateContributorNames = this._updateContributorNames.bind(this);
			this.deleteElementWidgetAt = this.deleteElementWidgetAt.bind(this);
			
			this.editBlip = this.editBlip.bind(this);
			this.finishBlip = this.finishBlip.bind(this);
			this.deleteBlip = this.deleteBlip.bind(this);
			this.toggleDraft = this.toggleDraft.bind(this);
			
			this.parent(parentElement, contentElement, where);
		},
		/**
		 * Overridden from {@link pygowave.view.Widget.dispose Widget.dispose}.<br/>
		 * Inject this widget somewhere else. Sets the parent element.<br/>
		 * Note: Called by initialize.
		 * @function {public BlipEditorWidget} inject
		 * @param {Element} parentElement New parent element
		 * @param {optional String} where Where to inject the contentElement
		 *        relative to the parent element. Can be 'top', 'bottom',
		 *        'after', or 'before'.
		 * @param {optional pygowave.model.Blip} blip New
		 *        Blip object to bind this element to.
		 * @return Returns a reference to this widget.
		 */
		inject: function (parentElement, where, blip) {
			this.parent(parentElement, where);
			
			if ($defined(blip))
				this._blip = blip;
			else
				blip = this._blip;
			this._elements = new Array();
			
			var ok = this.reloadContent();
			
			blip.addEvents({
				insertedText: this._onInsertedText,
				deletedText: this._onDeletedText,
				outOfSync: this._onOutOfSync,
				insertedElement: this._onInsertedElement,
				deletedElement: this._onDeletedElement,
				lastModifiedChanged: this._onLastModifiedChanged,
				contributorAdded: this._onContributorAdded
			});
			
			this.contentElement.addEvents({
				keydown: this._onKeyDown,
				keypress: this._onKeyPress,
				keyup: this._onKeyUp,
				contextmenu: this._onContextMenu
			});
			$(window).addEvents({
				mouseup: this._onMouseUp,
				mousedown: this._onMouseDown
			});
			
			if (ok)
				this._onSyncCheckTimer = this._onSyncCheck.periodical(2000, this);
			
			return this;
		},
		/**
		 * Overridden from {@link pygowave.view.Widget.dispose Widget.dispose}.<br/>
		 * Removes the widget from the DOM, sets the parentElement to null and
		 * disconnects from the Blip.
		 * 
		 * @function {public Widget} dispose
		 * @return Returns a reference to this widget.
		 */
		dispose: function () {
			this.parent();
			this._lastRange = null;
			this._lastContent = "";
			this._editing = false;
			this._draftMode = false;
			for (var it = new _Iterator(this._contributorObjects); it.hasNext(); )
				it.next().removeEvent("dataChanged", this._updateContributorNames);
			this._contributorObjects.empty();
			this._blip.removeEvents({
				insertedText: this._onInsertedText,
				deletedText: this._onDeletedText,
				outOfSync: this._onOutOfSync,
				insertedElement: this._onInsertedElement,
				deletedElement: this._onDeletedElement
			});
			this.contentElement.removeEvents({
				keydown: this._onKeyDown,
				keypress: this._onKeyPress,
				keyup: this._onKeyUp,
				contextmenu: this._onContextMenu
			});
			this._infobox_dropdown.removeEvent("click", this.editBlip);
			$(window).removeEvents({
				mouseup: this._onMouseUp,
				mousedown: this._onMouseDown
			});
			$clear(this._onSyncCheckTimer);
		},
		
		/**
		 * Returns the Blip rendered through this editor.
		 *
		 * @function {public pygowave.model.Blip} blip
		 */
		blip: function () {
			return this._blip;
		},
		
		/**
		 * Build the content elements from the Blip's string and insert it
		 * into the widget. Returns true on success, false otherwise.
		 * 
		 * @function {private Boolean} reloadContent
		 */
		reloadContent: function () {
			// Clean up first
			for (var it = new _Iterator(this._elements); it.hasNext(); ) {
				var ew = it.next();
				ew.removeEvent('deleteClicked', this.deleteElementWidgetAt);
				ew.destroy();
			}
			delete it;
			this._elements.empty();
			for (var it = new _Iterator(this._contributorViewWidgets); it.hasNext(); )
				it.next().destroy();
			delete it;
			this._contributorViewWidgets.empty();
			for (var it = new _Iterator(this.contentElement.getChildren()); it.hasNext(); )
				it.next().destroy();
			delete it;
			this._editControls = null;
			this.contentElement.setStyle("opacity", 1);
			this._removeErrorOverlay();
			
			var elementPosMap = new Hash();
			for (var it = new _Iterator(this._blip.allElements()); it.hasNext(); ) {
				var element = it.next();
				elementPosMap.set(element.position(), element);
			}
			delete it;
			
			// Build up
			var content = this._blip.content().replace(/  /g, "\u00a0\u00a0");
			var lines = content.split("\n"), line, pg, pos = 0;
			for (var i = 0; i < lines.length; i++) {
				if (elementPosMap.has(pos)) {
					var ew = new GadgetElementWidget(this._view, elementPosMap.get(pos), this.contentElement);
					ew.addEvent('deleteClicked', this.deleteElementWidgetAt);
					this._elements.push(ew);
					pos++;
					continue;
				}
				line = lines[i];
				pg = new Element("p");
				if (line != "")
					pg.set('text', line);
				if (!Browser.Engine.trident) // IE allows empty paragraphs
					new Element("br").inject(pg); // Others use an implicit br
				pg.inject(this.contentElement);
				pos += line.length + 1;
			}
			
			this._lastContent = this.contentToString();
			if (this._blip.content() != this._lastContent) {
				$clear(this._onSyncCheckTimer);
				this._displayErrorOverlay("render_fail");
				return false;
			}
			
			// Add contributors
			if (!this._blip.isRoot()) {
				this._contributorNames = new Element('span', {'class': "blip_editor_control"});
				this._contributorViews = new Element('div', {'class': "blip_editor_control"});
				this._contributorViews.addClass("blip_contributors");
				this._contributorViews.contentEditable = "false";
				
				var c = this._blip.creator();
				var cid = c.id();
				this._addContributorView(c);
				for (var it = new _Iterator(this._blip.allContributors()); it.hasNext(); ) {
					c = it.next();
					if (c.id() != cid)
						this._addContributorView(c);
				}
				delete it;
			}
			else {
				this._contributorNames = new Element('div', {'class': "blip_editor_control"});
				this._contributorNames.addClass("for_root_blip");
			}
			this._contributorNames.addClass("blip_contributor_names");
			this._contributorNames.contentEditable = "false";
			this._updateContributorNames();
			this._contributorNames.inject(this.contentElement, "top");
			if (!this._blip.isRoot())
				this._contributorViews.inject(this.contentElement, "top");
			
			// Add other controls/infos
			this._infobox = new Element('div', {'class': "blip_editor_control"});
			this._infobox.addClass("blip_infobox");
			this._infobox.contentEditable = "false";
			this._infotext = new Element('span').inject(this._infobox);
			this._onLastModifiedChanged(this._blip.lastModified());
			this._infobox_dropdown = new Element('div', {
				'class': "blip_editor_control",
				'title': gettext("Edit Blip")
			});
			this._infobox_dropdown.addClass("blip_dropdown");
			this._infobox_dropdown.inject(this._infobox);
			this._infobox.inject(this.contentElement, "top");
			
			//TODO: Real dropdown
			this._infobox_dropdown.addEvent('click', this.editBlip);
			
			if (this._editing) {
				this._editing = false;
				this.editBlip();
			}
			return true;
		},
		/**
		 * Starts editing the Blip
		 * @function {public} editBlip
		 */
		editBlip: function () {
			if (this._editing)
				return;
			this.contentElement.contentEditable = "true";
			if ($defined(this._editControls)) {
				this._editControls.setStyle("top", "");
				this._editControls.setStyle("position", "");
				this._editControls.setStyle("visibility", "visible");
			}
			else {
				this._editControls = new Element('div',  {
					'class': "blip_editor_control"
				});
				this._editControls.addClass("blip_edit_controls");
				if (!this._blip.isRoot()) {
					new Element("button", {
						'type': "button",
						'class': "mochaButton",
						'text': gettext("Delete")
					}).addEvent('click', this.deleteBlip).inject(this._editControls);
				}
				new Element("button", {
					'type': "button",
					'class': "mochaButton",
					'text': gettext("Done")
				}).addEvent('click', this.finishBlip).inject(this._editControls);
				var draftCheckDiv = new Element("div", {
					'class': 'blip_draft_check',
					'text': gettext("Draft"),
					'title': gettext("Not yet implemented by Google...")
				});
				this._draftCheck = new Element("div", {
					'class': "box"
				}).addEvent('click', this.toggleDraft).inject(draftCheckDiv, "top");
				if (this._draftMode)
					this._draftCheck.addClass("checked");
				draftCheckDiv.inject(this._editControls);
				this._editControls.inject(this.contentElement, "bottom");
				this._editControls.contentEditable = "false";
			}
			for (var it = new _Iterator(this._elements); it.hasNext(); )
				it.next().setDeleteBoxVisible(true);
			this._editing = true;
			this.fireEvent("blipEditing", this._blip.id());
			this.contentElement.focus();
			var ret = this._walkDown(this.contentElement, this._blip.content().length);
			var sel = new Selection(ret[0], ret[1], ret[0], ret[1]);
			sel.select();
			this._lastRange = this.currentTextRange(this.contentElement);
			if ($defined(this._lastRange))
				this._lastValidRange = this._lastRange;
		},
		/**
		 * Stop editing the Blip
		 * @function {public} finishBlip
		 */
		finishBlip: function () {
			if (!this._editing)
				return;
			this.toggleDraft(false);
			for (var it = new _Iterator(this._elements); it.hasNext(); )
				it.next().setDeleteBoxVisible(false);
			this._editControls.setStyle("visibility", "hidden");
			this._editControls.setStyle("position", "absolute");
			this._editControls.setStyle("top", "0");
			this.contentElement.contentEditable = "false";
			this._editing = false;
			this.fireEvent("blipDone", this._blip.id());
		},
		/**
		 * Deletes the Blip (does nothing on root Blips).
		 * @function {public} deleteBlip
		 */
		deleteBlip: function () {
			if (this._blip.isRoot())
				return;
			if (this._editing)
				this.finishBlip();
			this._view.fireEvent('deleteBlip', [this._blip.wavelet().id(), this._blip.id()]);
		},
		/**
		 * Toggles Draft mode
		 * @function {public} toggleDraft
		 * @param {optional bool} enabled
		 */
		toggleDraft: function (enabled) {
			if ($type(enabled) != "boolean")
				this._draftMode = !this._draftMode;
			else
				this._draftMode = enabled;
			if (this._draftMode)
				this._draftCheck.addClass("checked");
			else
				this._draftCheck.removeClass("checked");
			this._view.fireEvent('draftBlip', [this._blip.wavelet().id(), this._blip.id(), this._draftMode]);
		},
		
		/**
		 * Places an overlay over the editor and displays an error message with
		 * a button.
		 * @function {private} _displayErrorOverlay
		 * @param {String} type Error type. May be 'resync', 'render_fail'.
		 */
		_displayErrorOverlay: function (type) {
			this._removeErrorOverlay();
				
			this._errDiv = new Element("div", {'class': 'error_overlay'}).inject(this.contentElement, 'bottom');
			var msgdiv = new Element("div", {'class': 'msg_div'}).inject(this._errDiv);
			var bg_div = new Element("div", {'class': 'bg_div'}).inject(this._errDiv);
			bg_div.setStyle("opacity", 0.5);
			
			switch (type) {
				case "resync":
					new Element("div", {'class': 'msg', 'text': gettext("Sorry, but this Blip Editor has gone out of sync with the internal representation. Please click resync.")}).inject(msgdiv);
					new Element("button", {'class': 'mochaButton', 'text': gettext("Resync")})
						.inject(msgdiv).addEvent('click', this.reloadContent.bind(this));
					break;
				
				case "render_fail":
					new Element("div", {'class': 'msg', 'text': gettext("The text content could not be rendered correctly. This may be a bug or you are using an unsupported browser.")}).inject(msgdiv);
					new Element("button", {'class': 'mochaButton', 'text': gettext("Dismiss")})
						.inject(msgdiv).addEvent('click', this._removeErrorOverlay.bind(this));
					$clear(this._onSyncCheckTimer);
					break;
				
				case "checksum_fail":
					new Element("div", {'class': 'msg', 'text': gettext("Unfortunately, this Blip has gone out of sync with the server. You have to reload the page to be able to use it again.")}).inject(msgdiv);
					new Element("button", {'class': 'mochaButton', 'text': gettext("Reload")})
						.inject(msgdiv).addEvent('click', function () {
							window.location.href = window.location.href;
						});
					$clear(this._onSyncCheckTimer);
					break;
			}
			
			this._errDiv.setStyle('opacity', 0);
			
			new Fx.Tween(this._errDiv, {duration: 250}).start("opacity", 0, 1);
			new Fx.Scroll(this.parentElement, {
				duration: 250,
				wait: false
			}).toElement(this._errDiv);
			
			this.contentElement.contentEditable = "false";
		},
		/**
		 * Removes the error overlay displayed by _displayErrorOverlay.
		 * @function {private} _removeErrorOverlay
		 */
		_removeErrorOverlay: function ()  {
			if (!$defined(this._errDiv))
				return;
			this.contentElement.setStyle("opacity", 1);
			var toKill = this._errDiv;
			this._errDiv = null;
			new Fx.Tween(toKill, {duration: 250}).start("opacity", 1, 0).chain(function () {
				toKill.destroy();
				toKill = null;
			});
		},
		
		/**
		 * Retrieve the content as a simple string (converting paragraphs to
		 * newlines).
		 * @function {public String} contentToString
		 */
		contentToString: function () {
			var cleaned = "", first = true;
			for (var it = new _Iterator(this.contentElement.getChildren()); it.hasNext(); ) {
				var elt = it.next();
				if (elt.get('tag') != "p" && (elt.get('tag') != "div" || !elt.hasClass("gadget_element")))
					continue;
				
				if (first)
					first = false;
				else
					cleaned += "\n";
				
				if (elt.get('tag') == "p")
					cleaned += elt.get('text').replace(/\u00a0/gi, " ");
			}
			return cleaned;
		},
		/**
		 * Returns the current selected text range as [start, end]. This
		 * ignores all element nodes except gadget elements (which is treated as 1 character).
		 * @function {public Array} currentTextRange
		 * @param {optional Element} target Target from the event object to check
		 *        against the scope
		 */
		currentTextRange: function (target) {
			var sel = Selection.currentSelection(this.contentElement, target);
			
			if (!sel.isValid()) {
				this.fireEvent("currentTextRangeChanged", [null, null]);
				return null;
			}
			
			sel.moveDown();
			var start = this._walkUp(sel.startNode(), sel.startOffset());
			var end = this._walkUp(sel.endNode(), sel.endOffset());
			
			this.fireEvent("currentTextRangeChanged", [start, end]);
			return [start, end];
		},
		/**
		 * Returns the last text range which was succesfully retrieved
		 * as [start, end].
		 *
		 * @function {public Array} lastValidTextRange
		 */
		lastValidTextRange: function () {
			return this._lastValidRange;
		},
		/**
		 * Check if at a line start and insert a newline if not.
		 * Helper method for gadget insertion. Returns false if a newline had
		 * to be inserted, true if everything is ok.
		 *
		 * @function {public Boolean} checkOrAddNewline
		 * @param {int} index Index at which to check for a newline
		 */
		checkOrAddNewline: function (index) {
			var text = this.contentToString();
			if (index > 0 && text.substr(index-1, 1) != "\n") {
				this._onInsertedText(index, "\n");
				this._view.setBusy();
				this._view.fireEvent(
					'textInserted',
					[
						this._blip.wavelet().id(),
						this._blip.id(),
						index,
						"\n"
					]
				);
				this._view.unsetBusy();
				return false;
			}
			return true;
		},
		/**
		 * Returns the GadgetElementWidget with the specified GadgetElement
		 * or null.
		 * 
		 * @function {public GadgetElementWidget} elementWidgetFor
		 * @param {pygowave.model.GadgetElement} elt
		 */
		elementWidgetFor: function (elt) {
			for (var it = new _Iterator(this._elements); it.hasNext(); ) {
				var ew = it.next();
				if (ew.element() == elt)
					return ew;
			}
			return null;
		},
		/**
		 * Returns the GadgetElementWidget at the specified index or null.
		 *
		 * @function {public GadgetElementWidget} elementWidgetAt
		 * @param {int} index
		 */
		elementWidgetAt: function (index) {
			for (var it = new _Iterator(this._elements); it.hasNext(); ) {
				var ew = it.next();
				if (ew.position() == index)
					return ew;
			}
			return null;
		},
		/**
		 * Deletes the GadgetElementWidget at the specified index and fires
		 * an event for the controller.
		 *
		 * @function {public} deleteElementWidgetAt
		 * @param {int} index Index at which to delete the element
		 * @param {optional Boolean} no_event Do not fire an event if set to true
		 */
		deleteElementWidgetAt: function (index, no_event) {
			if (!$defined(no_event)) no_event = false;
			
			for (var i = 0; i < this._elements.length; i++) {
				var ew = this._elements[i];
				if (ew.position() == index) {
					this._elements.pop(i);
					ew.removeEvent('deleteClicked', this.deleteElementWidgetAt);
					ew.destroy();
					break;
				}
			}
			
			if (!no_event) {
				this._view.fireEvent(
					'elementDelete',
					[
						this._blip.wavelet().id(),
						this._blip.id(),
						index
					]
				);
			}
		},
		
		_onKeyDown: function (e) {
			// Capture Shift+Enter
			if (e.shift && e.key == 'enter') {
				e.stop();
				this.finishBlip();
				return;
			}
			this._firstKeyPress = true;
			this._view.setBusy();
		},
		
		_onKeyPress: function (e) {
			if (Browser.Engine.presto && !this._firstKeyPress)
				this._processKey(e);
			this._firstKeyPress = false;
		},
		
		_onKeyUp: function(e) {
			this._processKey(e);
			this._view.unsetBusy();
		},
		
		/**
		 * Callback from underlying DOM element on key release/press. Generates
		 * events for the controller (which in turn generates operations).
		 *
		 * @function {private} _processKey
		 * @param {Object} e Event object
		 */
		_processKey: function(e) {
			if (!this._editing)
				return;
			var newRange = this.currentTextRange(e.target);
			if (!$defined(newRange))
				return;
			var newContent = this.contentToString();
			
			// Notes: Does some checks before acting; the context menu is not handeled properly.
			if (newContent.length != this._lastContent.length || newContent != this._lastContent) {
				if (e.key == "backspace" || e.key == "delete") {
					if (this._lastRange[0] != this._lastRange[1])
						this._checkDelete(this._lastRange[0], this._lastRange[1]);
					else if (e.key == "backspace")
						this._checkDelete(this._lastRange[0]-1, this._lastRange[0]);
					else if (e.key == "delete" && this._lastRange[0] != this._lastContent.length)
						this._checkDelete(this._lastRange[0], this._lastRange[0]+1);
				}
				else if (newRange[0] > this._lastRange[0] && e.code != 35 // Exclude arrow keys
						&& e.code != 37 && e.code != 38 && e.code != 39 && e.code != 40) {
					if (this._lastRange[0] != this._lastRange[1])
						this._checkDelete(this._lastRange[0], this._lastRange[1]);
					this._view.fireEvent(
						'textInserted',
						[
							this._blip.wavelet().id(),
							this._blip.id(),
							this._lastRange[0],
							newContent.slice(this._lastRange[0], newRange[0])
						]
					);
				}
			}
			
			this._lastContent = newContent;
			this._lastRange = newRange;
			this._lastValidRange = newRange;
		},
		_onMouseDown: function (e) {
			// Currently not needed
		},
		_onMouseUp: function(e) {
			this._lastRange = this.currentTextRange(e.target);
			if ($defined(this._lastRange))
				this._lastValidRange = this._lastRange;
		},
		_onContextMenu: function (e) {
			return false; // Context menu is blocked
		},
		/**
		 * Helper function to fire textDeleted and elementDeleted events as
		 * appropriate.
		 *
		 * @function {public} _checkDelete
		 * @param {int} start
		 * @param {int} end
		 */
		_checkDelete: function (start, end) {
			var waveletId = this._blip.wavelet().id();
			for (var it = new _Iterator(this._blip.elementsWithin(start, end)); it.hasNext(); ) {
				var elt = it.next();
				if (elt.position() > start) {
					end -= elt.position() - start;
					this._view.fireEvent(
						'textDeleted',
						[
							waveletId,
							this._blip.id(),
							start,
							elt.position()
						]
					);
				}
				this.deleteElementWidgetAt(start);
				end--;
			}
			
			if (start != end) {
				this._view.fireEvent(
					'textDeleted',
					[
						waveletId,
						this._blip.id(),
						start,
						end
					]
				);
			}
		},
		/**
		 * Check if the parent paragraph is empty and has no trailing &lt;br&gt;
		 *
		 * @function {private} _fixPara
		 * @param {Node} elt
		 */
		_fixPara: function (elt) {
			if (!$defined(elt) || Browser.Engine.trident)
				return;
			while ($type(elt) != 'element' || elt.get('tag') != "p")
				elt = elt.parentNode;
			if (!$defined(elt.lastChild) || $type(elt.lastChild) != "element" || elt.lastChild.get('tag') != "br")
				new Element("br").inject(elt);
		},
		
		/**
		 * Callback from model on text insertion
		 *
		 * @function {private} _onInsertedText
		 * @param {int} index Index of the inserion
		 * @param {String} text Text to be inserted
		 */
		_onInsertedText: function (index, text) {
			//TODO: this function assumes no formatting elements
			this._view.setBusy();
			
			text = text.replace(/  /g, "\u00a0\u00a0").replace(/^ | $/g, "\u00a0"); // Convert spaces to protected spaces
			var length = text.length;
			var ret = this._walkDown(this.contentElement, index);
			var elt = ret[0], offset = ret[1], newelt, newtn;
			if ($type(elt) == "element"	&& elt.get('tag') == "p") { // Empty paragraphs
				newtn = document.createTextNode("");
				if (!Browser.Engine.trident)
					elt.insertBefore(newtn, elt.firstChild);
				else
					elt.appendChild(newtn);
				elt = newtn;
				offset = 0;
			}
			var lines = text.split("\n"), rest;
			var parent = elt.parentNode; // Parent paragraph
			for (var i = 0; i < lines.length; i++) {
				if (lines[i].length > 0) {
					if (!$defined(elt.data)) {
						dbgprint("wtf!");
					}
					if (offset == elt.data.length && Browser.Engine.trident) { // Appending is buggy in IE
						elt.appendData(" ");
						elt.insertData(offset, lines[i]);
						elt.deleteData(elt.data.length-1, 1);
					}
					else
						elt.insertData(offset, lines[i]);
				}
				if (i < lines.length-1) { // Handle newlines
					if (offset < elt.data.length && offset+lines[i].length == 0) {
						// Special case: effectively append an empty node before the current node
						newelt = new Element("p").inject(parent, 'before');
						if (!Browser.Engine.trident)
							new Element("br").inject(newelt);
						newelt = elt;
					}
					else {
						newelt = new Element("p").inject(parent, 'after');
						if (offset < elt.data.length) {
							if (offset+lines[i].length > 0)
								elt.splitText(offset+lines[i].length); // Split
						}
						
						// Move siblings to new node
						if (!Browser.Engine.trident) {
							new Element("br").inject(newelt);
							while ($defined(elt.nextSibling) && ($type(elt.nextSibling) != "element" || elt.nextSibling.get('tag') != "br" || elt.nextSibling != parent.lastChild))
								newelt.insertBefore(elt.nextSibling, newelt.firstChild);
						}
						else {
							while ($defined(elt.nextSibling)) {
								if ($defined(newelt.firstChild))
									newelt.insertBefore(elt.nextSibling, newelt.firstChild);
								else
									newelt.appendChild(elt.nextSibling);
							}
						}
						
						if (!$defined(newelt.firstChild))
							newelt.appendChild(document.createTextNode(""));
					}
					
					elt = newelt.firstChild;
					offset = 0;
				}
			}
			
			if ($defined(this._lastRange) && index < this._lastRange[0]) {
				this._lastRange = this.currentTextRange();
				if ($defined(this._lastRange))
					this._lastValidRange = this._lastRange;
			}
			
			this._view.unsetBusy();
		},
		/**
		 * Callback from model on text deletion
		 *
		 * @function {private} _onDeletedText
		 * @param {int} index Index of the deletion
		 * @param {String} length How many characters to delete
		 */
		_onDeletedText: function (index, length) {
			// Safe for formatting elements
			this._view.setBusy();
			var rlength = length; // Remaining length
			
			var ret = this._walkDown(this.contentElement, index);
			var elt = ret[0], next = null;
			var offset = ret[1], dellength = 0;
			if ($type(elt) == "element" && elt.get('tag') == "br") // Got the implicit br (TODO should be impossible to reach; check again)
				elt = elt.parentElement;
			while (rlength > 0 && $defined(elt)) {
				next = this._nextTextOrPara(elt);

				if ($type(elt) == "textnode") {
					dellength = elt.data.length-offset;
					if (dellength > rlength)
						dellength = rlength;
					if (dellength > 0)
						elt.deleteData(offset, dellength);
					this._fixPara(elt);
					rlength -= dellength;
					if (rlength > 0 && $type(next) == "element" && next.get('tag') == "p") {
						// Merge, then next is empty and will be deleted
						if (!Browser.Engine.trident) {
							while ($defined(next.firstChild) && next.firstChild != next.lastChild)
								elt.parentNode.insertBefore(next.firstChild, elt.parentNode.lastChild);
						}
						else {
							while ($defined(next.firstChild))
								elt.parentNode.appendChild(next.firstChild);
						}
					}
				}
				else if ($type(elt) == "element" && elt.get('tag') == "p") { // Empty p
					elt.dispose();
					rlength--;
				}
				elt = next;
				offset = 0;
			}
			
			if ($defined(this._lastRange) && index < this._lastRange[0]) {
				this._lastRange = this.currentTextRange();
				if ($defined(this._lastRange))
					this._lastValidRange = this._lastRange;
			}
			
			this._view.unsetBusy();
		},
		/**
		 * Callback from model if an element was inserted.
		 *
		 * @param {int} index Offset where the element is inserted
		 */
		_onInsertedElement: function (index) {
			this._view.setBusy();
			
			var elt = this._blip.elementAt(index);
			
			// Note: We should always be on the beginning of a line, so just
			// prepend the element
			var para = this._walkDown(this.contentElement, index)[0];
			while ($type(para) != 'element' || para.get('tag') != "p")
				para = para.parentNode;
			
			//TODO other elements
			var ew = new GadgetElementWidget(this._view, elt, para, 'before');
			if (this._editing)
				ew.setDeleteBoxVisible(true);
			ew.addEvent('deleteClicked', this.deleteElementWidgetAt);
			
			this._elements.push(ew);
			
			if ($defined(this._lastRange) && index < this._lastRange[0]) {
				this._lastRange = this.currentTextRange();
				if ($defined(this._lastRange))
					this._lastValidRange = this._lastRange;
			}
			
			this._view.unsetBusy();
		},
		/**
		 * Callback from model if an element was deleted.
		 *
		 * @param {int} index Offset where the element is deleted
		 */
		_onDeletedElement: function (index) {
			this._view.setBusy();
			
			this.deleteElementWidgetAt(index, true);
			
			if ($defined(this._lastRange) && index < this._lastRange[0]) {
				this._lastRange = this.currentTextRange();
				if ($defined(this._lastRange))
					this._lastValidRange = this._lastRange;
			}
			
			this._view.unsetBusy();
		},
		/**
		 * Callback from model if blip has gone out of sync with the server
		 *
		 * @function {private} _onOutOfSync
		 */
		_onOutOfSync: function () {
			this._displayErrorOverlay('checksum_fail');
		},
		/**
		 * Callback from model if the Blip's date/time of last modification
		 * changed.
		 *
		 * @function {private} _onLastModifiedChanged
		 * @param {param} date
		 */
		_onLastModifiedChanged: function (date) {
			var formattedDate = "?";
			var blipDate = new Date(date);
			var now = new Date();
			if (now.getYear() == blipDate.getYear()) {
				if (now.getMonth() == blipDate.getMonth() && now.getDate() == blipDate.getDate())
					formattedDate = "%02d:%02d".sprintf(blipDate.getHours(), blipDate.getMinutes());
				else
					formattedDate = "%s %d".sprintf(monthname(blipDate.getMonth()), blipDate.getDate());
			}
			else {
				var yr = blipDate.getFullYear();
				yr = yr - (parseInt(yr / 100) * 100);
				formattedDate = "%s %d, '%02d".sprintf(monthname(blipDate.getMonth()), blipDate.getDate(), yr);
			}
			this._infotext.set("text", formattedDate);
		},
		/**
		 * Callback from model if a contributor has been added.
		 *
		 * @function {private} _onContributorAdded
		 * @param {String} id His/her/its ID
		 */
		_onContributorAdded: function (id) {
			if (!this._blip.isRoot())
				this._addContributorView(this._blip.wavelet().participant(id));
			this._updateContributorNames();
		},
		_addContributorView: function (c) {
			var wgt = new ParticipantWidget(this._view, this._contributorViews, c, 'small');
			this._contributorViewWidgets.push(wgt);
		},
		_updateContributorNames: function () {
			var c = this._blip.creator();
			var cid = c.id();
			var names = new Array();
			if (c.displayName() != "")
				names.push(c.displayName());
			else
				names.push(cid);

			var contributors = this._blip.allContributors();
			for (var it = new _Iterator(contributors); it.hasNext(); ) {
				c = it.next();
				if (c.id() != cid) {
					if (c.displayName() != "")
						names.push(c.displayName());
					else
						names.push(c.id());
				}
				if (!this._contributorObjects.has(c.id())) {
					c.addEvent("dataChanged", this._updateContributorNames);
					this._contributorObjects.set(c.id(), c);
				}
			}
			if (names.length == 1)
				names = names[0];
			else
				names = names.slice(0, names.length-1).join(", ") + gettext(" and ") + names[names.length-1];
			this._contributorNames.set('text', names+':');
		},
		
		/**
		 * Utility function. Splits up a textnode in a paragraph at the
		 * given position.
		 *
		 * @function {private} _spitPara
		 * @param {Element} elt The textnode to split
		 * @param {int} offset Spit offset
		 */
		_spitPara: function (elt, offset) {
			var parent = elt.parentNode;
			while (parent.get('tag') == "p")
				parent = elt.parentNode;
			
			//TODO
		},
		/**
		 * Walk up the DOM tree while summing up all text lengths. Elements are
		 * ignored, except p which is the line container and gadget elements
		 * which count as one character. Returns the absolute offset.
		 * 
		 * @function {private int} _walkUp
		 * @param {Node} node The node to start
		 * @param {int} nodeOffset The node offset to start
		 */
		_walkUp: function (node, nodeOffset) {
			var offset = 0;
			var prev = node;
			
			if ($type(node) == "textnode" || $type(node) == "whitespace")
				offset = nodeOffset;
			else { // Not completely at the bottom
				node = node.firstChild;
				while (node != null && nodeOffset > 0) {
					prev = node;
					node = node.nextSibling;
					nodeOffset--;
				}
				if (node == null)
					node = prev;
				else
					prev = node;
			}
			
			while (node != null && node != this.contentElement) {
				while ((node = node.previousSibling) != null) {
					prev = node;
					if ($type(node) == "element") {
						if (node.get('tag') == "br" || (node.get('tag') == "div" && node.hasClass("gadget_element")))
							offset++;
						else if (node.get('tag') == "span" && node.hasClass("blip_editor_control")) {
							/*pass*/
						}
						else if (node.get('tag') != "div" || !node.hasClass("blip_editor_control")) {
							if (node.get('tag') == "p")
								offset++;
							// descend
							while ((node = node.lastChild) != null) {
								prev = node;
								if ($type(node) == "textnode") {
									offset += node.data.length;
									break;
								}
							}
						}
						node = prev;
					}
					else if ($type(node) == "textnode")
						offset += node.data.length;
				}
				// ascend
				node = prev.parentNode;
				prev = node;
			}
			return offset;
		},
		/**
		 * Walk down the DOM tree. Opposite of {@link pygowave.view.BlipEditor._walkUp _walkUp}.
		 * Returns a list [node, nodeOffset].
		 * 
		 * @function {private Array} _walkDown
		 * @param {Element} body Body element
		 * @param {int} offset Absolute offset to walk down
		 */
		_walkDown: function (body, offset) {
			var elt = body.firstChild, next;
			
			while ($type(elt) == "element" && elt.get('tag') != "p") { // gadget_element at start
				if (!elt.hasClass('blip_editor_control'))
					offset--;
				elt = this._nextTextOrPara(elt, true, true);
			}
			if (offset < 0 || elt == null)
				return [new Element("p"), 0]; // Panic

			next = this._nextTextOrPara(elt, true, true); // Try to descend to first text node
			if ($type(next) == "textnode")
				elt = next;
			
			while (offset > 0 && elt != null) {
				next = this._nextTextOrPara(elt, true, true);
				if ($type(elt) == "element") { // p or gadget_element
					offset--;
					if (offset == 0 && elt.get('tag') == "p" && (next == null || $type(next) == "element")) // Empty p
						break;
				}
				else if ($type(elt) == "textnode") {
					if (offset <= elt.data.length)
						break;
					offset -= elt.data.length;
				}
				elt = next;
			}
			
			if (offset == 0 && $type(elt) == "element" && elt.get('tag') == "p") {
				next = this._nextTextOrPara(elt, true, true); // Try to descend to first text node
				if ($type(next) == "textnode")
					elt = next;
			}
			
			return [elt, offset];
		},
		/**
		 * Find the next TextNode or Paragraph.
		 * 
		 * @function {private Node} _nextTextOrPara
		 * @param {Node} elt Start node
		 * @param {optional Boolean} descend Set to true if you want to descend
		 *        first if possible, rather than moving to the next sibling.
		 * @param {optional Boolean} ge_stop Set to true if you also want
		 *        gadget elements to be returned.
		 */
		_nextTextOrPara: function (elt, descend, ge_stop) {
			if (!$defined(descend))
				descend = false;
			if (!$defined(ge_stop))
				ge_stop = false;
			
			var next;
			if (descend
					&& $type(elt) == "element"
					&& (elt.get('tag') != "span" || !elt.hasClass("blip_editor_control"))
					&& (elt.get('tag') != "div" || (!elt.hasClass("gadget_element") && !elt.hasClass("blip_editor_control")))
					&& $defined(elt.firstChild))
				next = elt.firstChild;
			else
				next = elt.nextSibling;
			
			while (!$defined(next) || $type(next) == "element") {
				if (!$defined(next)) { // ascend
					elt = elt.parentNode;
					if (elt == this.contentElement)
						return null; // The end
					next = elt.nextSibling;
					continue;
				}
				if (next.get('tag') == "p")
					return next; // Done
				else { // descend or move forward
					elt = next;
					if (ge_stop && elt.get('tag') == "div" && elt.hasClass("gadget_element"))
						return elt;
					if ($defined(elt.firstChild)
							&& (elt.get('tag') != "div" || (!elt.hasClass("gadget_element") && !elt.hasClass("blip_editor_control")))
							&& (elt.get('tag') != "span" || !elt.hasClass("blip_editor_control")))
						next = elt.firstChild;
					else
						next = elt.nextSibling;
				}
			}
			
			return next;
		},
		/**
		 * This function is called periodically to check Blip rendering
		 * consistency.
		 * @function {private} _onSyncCheck
		 */
		_onSyncCheck: function () {
			if (this._view.isBusy())
				return;
			
			var content = this.contentToString();
			if (content != this._blip.content()) {
				if (!$defined(this._errDiv)) {
					//dbgprint("diff: "+this._diff(content, this._blip.content()));
					this._displayErrorOverlay("resync");
				}
			}
			else if ($defined(this._errDiv))
				this._removeErrorOverlay();
		},
		_diff: function (a, b) {
			if (a.length > b.length)
				return "a > b";
			if (a.length < b.length)
				return "a < b";
			for (var i = 0; i < a.length; i++) {
				if (a[i] != b[i])
					return "a[%d] != b[%d] / %d != %d".sprintf(i,i,a.charCodeAt(i),b.charCodeAt(i));
			}
			return "a == b";
		}
	});

	pygowave.view.extend({
		BlipEditorWidget: BlipEditorWidget
	});
})();
