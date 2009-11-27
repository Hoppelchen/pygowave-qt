/*
 * This file is part of the PyGoWave Qt/C++ Client API
 *
 * Copyright (C) 2009 Patrick Schneider <patrick.p2k.schneider@googlemail.com>
 *
 * This library is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation, either
 * version 3 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General
 * Public License along with this library; see the file
 * COPYING.LESSER.  If not, see <http://www.gnu.org/licenses/>.
 */

#include "controller.h"
#include "model.h"
#include "operations.h"

#include <qstomp/qstomp.h>

#include <qjson/parser.h>
#include <qjson/serializer.h>

#include <QtCore/QUuid>
#include <QtCore/QRegExp>
#include <QtCore/QTimer>

#include "controller_p.h"

using namespace PyGoWave;

Controller::Controller(QObject * parent) : QObject(parent), pd_ptr(new ControllerPrivate(this))
{
	P_D(Controller);
	d->m_state = Controller::ClientDisconnected;

	d->m_stompServer = "localhost";
	d->m_stompPort = 61613;
	d->m_stompUsername = "pygowave_client";
	d->m_stompPassword = "pygowave_client";

	d->jparser = new QJson::Parser();
	d->jserializer = new QJson::Serializer();

	d->conn = new QStompClient(this);

	d->pingTimer = new QTimer(this);
	d->pingTimer->setInterval(20000);
	d->pendingTimer = new QTimer(this);
	d->pendingTimer->setInterval(10000);

	d->m_lastSearchId = 0;

	connect(d->conn, SIGNAL(socketConnected()), this, SLOT(_q_conn_socketConnected()));
	connect(d->conn, SIGNAL(socketDisconnected()), this, SLOT(_q_conn_socketDisconnected()));
	connect(d->conn, SIGNAL(frameReceived()), this, SLOT(_q_conn_frameReceived()));
	connect(d->conn, SIGNAL(socketStateChanged(QAbstractSocket::SocketState)), this, SLOT(_q_conn_socketStateChanged(QAbstractSocket::SocketState)));
	connect(d->pingTimer, SIGNAL(timeout()), this, SLOT(_q_pingTimer_timeout()));
	connect(d->pendingTimer, SIGNAL(timeout()), this, SLOT(_q_pendingTimer_timeout()));
}

Controller::~Controller()
{
	P_D(Controller);
	delete d->jparser;
	delete d->jserializer;
	foreach (QByteArray id, d->m_allParticipants.keys())
		delete d->m_allParticipants.take(id);
	delete d;
}

void Controller::connectToHost(const QString &stompServer, const QString & username, const QString & password, int stompPort, const QByteArray & stompUsername, const QByteArray & stompPassword)
{
	P_D(Controller);
	d->m_stompServer = stompServer;
	d->m_stompPort = stompPort;
	d->m_stompUsername = stompUsername;
	d->m_stompPassword = stompPassword;
	this->reconnectToHost(username, password);
}

void Controller::reconnectToHost(const QString & username, const QString & password)
{
	P_D(Controller);
	d->m_username = username;
	d->m_password = password;
	qDebug("Controller: Connecting to %s:%d...", qPrintable(d->m_stompServer), d->m_stompPort);
	d->conn->connectToHost(d->m_stompServer, d->m_stompPort);
}

void Controller::disconnectFromHost()
{
	P_D(Controller);
	if (d->conn->socketState() == QAbstractSocket::ConnectedState) {
		d->sendJson("manager", "DISCONNECT", QVariant());
		d->conn->logout();
	}
}

QString Controller::hostName() const
{
	const P_D(Controller);
	return d->m_stompServer;
}

void ControllerPrivate::addWave(WaveModel * wave, bool initial)
{
	P_Q(Controller);
	Q_ASSERT(!this->m_allWaves.contains(wave->id()));
	this->m_allWaves[wave->id()] = wave;
	foreach (Wavelet * wavelet, wave->allWavelets()) {
		this->m_allWavelets[wavelet->id()] = wavelet;
		OpManager * mcached = new OpManager(wavelet->waveId(), wavelet->id(), q);
		q->connect(mcached, SIGNAL(afterOperationsInserted(int,int)), q, SLOT(_q_mcached_afterOperationsInserted(int,int)));
		q->connect(wavelet, SIGNAL(participantsChanged()), q, SLOT(_q_wavelet_participantsChanged()));
		this->mcached[wavelet->id()] = mcached;
		this->mpending[wavelet->id()] = new OpManager(wavelet->waveId(), wavelet->id(), q);
		this->ispending[wavelet->id()] = false;
	}
	bool created = false;
	if (this->m_createdWaveId == wave->id()) {
		this->m_createdWaveId.clear();
		created = true;
	}
	emit q->waveAdded(wave->id(), created, initial);
}

void ControllerPrivate::removeWave(const QByteArray &id, bool deleteObject)
{
	P_Q(Controller);
	Q_ASSERT(this->m_allWaves.contains(id));
	emit q->waveAboutToBeRemoved(id);
	WaveModel * wave = this->m_allWaves.take(id);
	foreach (Wavelet * wavelet, wave->allWavelets())
		this->m_allWavelets.remove(wavelet->id());
	if (deleteObject)
		wave->deleteLater();
}

void ControllerPrivate::clearWaves(bool deleteObjects)
{
	foreach (QByteArray id, this->m_allWaves.keys())
		this->removeWave(id, deleteObjects);
}

void ControllerPrivate::_q_conn_socketConnected()
{
	P_Q(Controller);
	qDebug("Controller: Logging into message broker...");
	this->m_state = Controller::ClientConnected;
	emit q->stateChanged(Controller::ClientConnected);
	this->conn->login(this->m_stompUsername, this->m_stompPassword);
}

void ControllerPrivate::_q_conn_socketDisconnected()
{
	P_Q(Controller);
	qDebug("Controller: Disconnected...");
	this->pingTimer->stop();
	this->m_state = Controller::ClientDisconnected;
	this->clearWaves(true);
	emit q->stateChanged(Controller::ClientDisconnected);
}

void ControllerPrivate::_q_conn_frameReceived()
{
	P_Q(Controller);
	foreach (QStompResponseFrame frame, this->conn->fetchAllFrames()) {
		if (this->m_state == Controller::ClientConnected) {
			if (frame.type() == QStompResponseFrame::ResponseConnected) {
				qDebug("Controller: Authenticating...");
				this->m_waveAccessKeyRx = QUuid::createUuid().toString().replace(QRegExp("\\{|\\}"), "").toAscii();
				this->m_waveAccessKeyTx = this->m_waveAccessKeyRx;

				this->subscribeWavelet("login", false);

				QVariantMap prop;
				prop["username"] = this->m_username;
				prop["password"] = this->m_password;
				this->m_password.clear(); // Delete Password after use
				this->sendJson("login", "LOGIN", prop);
			}
			else if (frame.type() == QStompResponseFrame::ResponseMessage) {
				bool ok = false;
				QVariantList msgs = this->jparser->parse(frame.rawBody(), &ok).toList();
				if (!ok) {
					qWarning("Controller: Error in parsing received JSON data!"); continue;
				}
				if (msgs.size() != 1) {
					qWarning("Controller: Login reply must contain a single message!"); continue;
				}
				QVariantMap msg = msgs.at(0).toMap();
				if (msg.contains("type") && msg.contains("property")) {
					QString type = msg["type"].toString();
					if (type == "ERROR") {
						QVariantMap prop = msg["property"].toMap();
						emit q->errorOccurred("login", prop["tag"].toString(), prop["desc"].toString());
						continue;
					}
					if (type != "LOGIN") {
						qWarning("Controller: Login reply must be a 'LOGIN' message!"); continue;
					}
					QVariantMap prop = msg["property"].toMap();
					if (prop.contains("rx_key") && prop.contains("tx_key") && prop.contains("viewer_id")) {
						this->unsubscribeWavelet("login", false);
						this->m_waveAccessKeyRx = prop["rx_key"].toByteArray();
						this->m_waveAccessKeyTx = prop["tx_key"].toByteArray();
						this->m_viewerId = prop["viewer_id"].toByteArray();
						this->subscribeWavelet("manager", false);
						this->pingTimer->start();
						this->m_state = Controller::ClientOnline;
						qDebug("Controller: Online! Keys: %s/rx %s/tx", this->m_waveAccessKeyRx.constData(), this->m_waveAccessKeyTx.constData());
						emit q->stateChanged(Controller::ClientOnline);

						this->sendJson("manager", "WAVE_LIST");
					}
					else {
						qWarning("Controller: Login reply must contain the properties 'rx_key', 'tx_key' and 'viewer_id'!"); continue;
					}
				}
				else {
					qWarning("Controller: Message lacks 'type' and 'property' field!"); continue;
				}
			}
		}
		else if (this->m_state == Controller::ClientOnline && frame.type() == QStompResponseFrame::ResponseMessage) {
			///qDebug("Controller: Received on %s:\n%s", frame.destination().constData(), qPrintable(frame.body()));
			bool ok = false;
			QList<QByteArray> routing_key = frame.destination().split('.');
			if (routing_key.size() != 3 || routing_key[2] != "waveop") {
				qWarning("Controller: Malformed routing key '%s'!", frame.destination().constData()); continue;
			}
			QByteArray waveletId = routing_key[1];
			QVariantList msgs = this->jparser->parse(frame.rawBody(), &ok).toList();
			if (!ok) {
				qWarning("Controller: Error in parsing received JSON data!"); continue;
			}
			foreach (QVariant vmsg, msgs) {
				QVariantMap msg = vmsg.toMap();
				if (msg.contains("type")) {
					if (msg.contains("property"))
						this->processMessage(waveletId, msg["type"].toString(), msg["property"]);
					else
						this->processMessage(waveletId, msg["type"].toString());
				}
				else {
					qWarning("Controller: Message lacks 'type' field!"); continue;
				}
			}
		}
	}
}

void ControllerPrivate::_q_conn_socketStateChanged(QAbstractSocket::SocketState state)
{
	qDebug("Controller: Socket state: %d", state);
}

Controller::ClientState Controller::state() const
{
	const P_D(Controller);
	return d->m_state;
}

WaveModel * Controller::wave(const QByteArray &id) const
{
	const P_D(Controller);
	if (d->m_allWaves.contains(id))
		return d->m_allWaves[id];
	else
		return NULL;
}

Wavelet * Controller::wavelet(const QByteArray &id) const
{
	const P_D(Controller);
	if (d->m_allWavelets.contains(id))
		return d->m_allWavelets[id];
	else
		return NULL;
}

Participant * Controller::participant(const QByteArray &id) const
{
	const P_D(Controller);
	if (d->m_allParticipants.contains(id))
		return d->m_allParticipants[id];
	else
		return NULL;
}

void Controller::openWavelet(const QByteArray &waveletId)
{
	P_D(Controller);
	d->subscribeWavelet(waveletId);
}

void Controller::closeWavelet(const QByteArray &waveletId)
{
	P_D(Controller);
	d->unsubscribeWavelet(waveletId);
}

void ControllerPrivate::_q_pingTimer_timeout()
{
	this->sendJson("manager", "PING", QString::number(this->timestamp()));
}

quint64 ControllerPrivate::timestamp()
{
	QDateTime now = QDateTime::currentDateTime().toUTC();
	quint64 ts = now.toTime_t() * 1000llu;
	ts += now.time().msec();
	return ts;
}

void ControllerPrivate::sendJson(const QByteArray & dest, const QString &type, const QVariant &property)
{
	if (this->m_waveAccessKeyTx.isEmpty()) return;
	QVariantMap obj;
	obj["type"] = type;
	if (property.isValid())
		obj["property"] = property;
	QStompRequestFrame frame(QStompRequestFrame::RequestSend);
	frame.setContentEncoding("utf-8");
	frame.setDestination(this->m_waveAccessKeyTx + "." + dest + ".clientop");
	frame.setHeaderValue("exchange", "wavelet.topic");
	frame.setHeaderValue("content-type", "application/json");
	frame.setRawBody(this->jserializer->serialize(obj));
	///if (dest != "login") qDebug("Controller: Sending to %s:\n%s", frame.destination().constData(), qPrintable(frame.body()));
	this->conn->sendFrame(frame);
	if (this->m_state == Controller::ClientOnline) {
		this->pingTimer->stop();
		this->pingTimer->start();
	}
}

void ControllerPrivate::subscribeWavelet(const QByteArray &id, bool open)
{
	this->conn->subscribe(
			this->m_waveAccessKeyRx + "." + id + ".waveop",
			true,
			QStompHeaderList()
			<< QPair<QByteArray,QByteArray>("routing_key", this->m_waveAccessKeyRx + "." + id + ".waveop")
			<< QPair<QByteArray,QByteArray>("exchange", "wavelet.direct")
			<< QPair<QByteArray,QByteArray>("exclusive", "true")
	);

	if (open)
		this->sendJson(id, "WAVELET_OPEN", QVariant());
}

void ControllerPrivate::unsubscribeWavelet(const QByteArray &id, bool close)
{
	if (close)
		this->sendJson(id, "WAVELET_CLOSE", QVariant());

	this->conn->unsubscribe(
			this->m_waveAccessKeyRx + "." + id + ".waveop",
			QStompHeaderList()
			<< QPair<QByteArray,QByteArray>("routing_key", this->m_waveAccessKeyRx + "." + id + ".waveop")
			<< QPair<QByteArray,QByteArray>("exchange", "wavelet.direct")
	);
}

void Controller::addParticipant(const QByteArray &waveletId, const QByteArray &id)
{
	P_D(Controller);
	if (!d->m_allWavelets.contains(waveletId))
		return;
	d->mcached[waveletId]->waveletAddParticipant(id);
	d->collateParticipants(id);
	d->m_allWavelets[waveletId]->addParticipant(d->m_allParticipants[id]);
}

void Controller::createNewWave(const QString &title)
{
	this->createNewWavelet("", title);
}

void Controller::createNewWavelet(const QByteArray &waveId, const QString &title)
{
	P_D(Controller);
	QVariantMap prop;
	prop["waveId"] = QString::fromAscii(waveId);
	prop["title"] = title;
	d->sendJson("manager", "WAVELET_CREATE", prop);
}

void Controller::leaveWavelet(const QByteArray &waveletId)
{
	P_D(Controller);
	if (!d->m_allWavelets.contains(waveletId))
		return;
	d->mcached[waveletId]->waveletRemoveParticipant(d->m_viewerId);
	d->m_allWavelets[waveletId]->removeParticipant(d->m_viewerId);
}

Wavelet * ControllerPrivate::newWaveletByDict(WaveModel * wave, const QByteArray &waveletId, const QVariantMap &waveletDict)
{
	QList<QByteArray> participants;
	foreach (QVariant part_id, waveletDict["participants"].toList())
		participants.append(part_id.toByteArray());
	if (!participants.contains(waveletDict["creator"].toByteArray()))
		this->collateParticipants(waveletDict["creator"].toByteArray());
	this->collateParticipants(participants);

	Wavelet * wavelet = wave->createWavelet(
		waveletId,
		this->m_allParticipants[waveletDict["creator"].toByteArray()],
		waveletDict["title"].toString(),
		waveletDict["isRoot"].toBool(),
		QDateTime::fromTime_t(waveletDict["creationTime"].toUInt()),
		QDateTime::fromTime_t(waveletDict["lastModifiedTime"].toUInt()),
		waveletDict["version"].toInt()
	);

	foreach (QByteArray part_id, participants)
		wavelet->addParticipant(this->m_allParticipants[part_id]);

	return wavelet;
}

void ControllerPrivate::updateWaveletByDict(Wavelet * wavelet, const QVariantMap &waveletDict)
{
	QSet<QByteArray> participants;
	foreach (QVariant part_id, waveletDict["participants"].toList())
		participants.insert(part_id.toByteArray());
	this->collateParticipants(participants.toList());

	wavelet->setTitle(waveletDict["title"].toString());
	wavelet->setLastModified(QDateTime::fromTime_t(waveletDict["lastModifiedTime"].toUInt()));

	QSet<QByteArray> newParticipants = participants;
	QSet<QByteArray> oldParticipants = QSet<QByteArray>::fromList(wavelet->allParticipantIDs());
	newParticipants.subtract(oldParticipants);
	oldParticipants.subtract(participants);

	foreach (QByteArray id, newParticipants)
		wavelet->addParticipant(this->m_allParticipants[id]);
	foreach (QByteArray id, oldParticipants)
		wavelet->removeParticipant(id);
}

void ControllerPrivate::collateParticipants(const QList<QByteArray> & participants)
{
	QList<QByteArray> todo;
	foreach (QByteArray id, participants) {
		if (!this->m_allParticipants.contains(id)) {
			this->m_allParticipants[id] = new Participant(id);
			todo.append(id);
		}
	}
	// Retrieve missing participants
	if (todo.size() > 0) {
		QVariantList l;
		foreach (QByteArray id, todo)
			l << QString::fromAscii(id);
		this->sendJson("manager", "PARTICIPANT_INFO", l);
	}
}

void ControllerPrivate::collateParticipants(const QByteArray & id)
{
	if (!this->m_allParticipants.contains(id)) {
		this->m_allParticipants[id] = new Participant(id);
		this->sendJson("manager", "PARTICIPANT_INFO", QVariantList() << QString::fromAscii(id));
	}
}

void ControllerPrivate::processMessage(const QByteArray &waveletId, const QString &type, const QVariant &property)
{
	P_Q(Controller);
	if (type == "ERROR") {
		QVariantMap propertyMap = property.toMap();
		emit q->errorOccurred(waveletId, propertyMap["tag"].toString(), propertyMap["desc"].toString());
		return;
	}
	// Manager messages
	if (waveletId == "manager") {
		if (type == "WAVE_LIST") {
			this->clearWaves(true); // Clear all; this message is only received once per connection
			QVariantMap propertyMap = property.toMap();
			foreach (QString s_waveId, propertyMap.keys()) {
				QByteArray waveId = s_waveId.toAscii();
				WaveModel * wave = new WaveModel(waveId, this->m_viewerId);
				QVariantMap wavelets = propertyMap[s_waveId].toMap();
				foreach (QString s_waveletId, wavelets.keys())
					this->newWaveletByDict(wave, s_waveletId.toAscii(), wavelets[s_waveletId].toMap());
				this->addWave(wave, true);
			}
		}
		else if (type == "WAVELET_LIST") {
			QVariantMap propertyMap = property.toMap();
			QByteArray waveId = propertyMap["waveId"].toByteArray();
			if (!this->m_allWaves.contains(waveId)) { // New wave
				WaveModel * wave = new WaveModel(waveId, this->m_viewerId);
				QVariantMap wavelets = propertyMap["wavelets"].toMap();
				foreach (QString s_waveletId, wavelets.keys())
					this->newWaveletByDict(wave, s_waveletId.toAscii(), wavelets[s_waveletId].toMap());
				this->addWave(wave, false);
			}
			else { // Update old
				WaveModel * wave = this->m_allWaves[waveId];
				QVariantMap wavelets = propertyMap["wavelets"].toMap();
				foreach (QString s_waveletId, wavelets.keys()) {
					QByteArray waveletId = s_waveletId.toAscii();
					Wavelet * wavelet = wave->wavelet(waveletId);
					if (wavelet)
						this->updateWaveletByDict(wavelet, wavelets[s_waveletId].toMap());
					else
						this->newWaveletByDict(wave, waveletId, wavelets[s_waveletId].toMap());
				}
			}
		}
		else if (type == "PARTICIPANT_INFO") {
			QVariantMap propertyMap = property.toMap();
			foreach (QString s_id, propertyMap.keys()) {
				QByteArray id = s_id.toAscii();
				Participant * p;
				if (this->m_allParticipants.contains(id))
					p = this->m_allParticipants[id];
				else {
					p = new Participant(id);
					this->m_allParticipants[id] = p;
				}
				p->updateData(propertyMap[s_id].toMap(), this->m_stompServer);
			}
		}
		else if (type == "PONG") {
			quint64 ts = this->timestamp();
			quint64 sentTs = property.toULongLong();
			if (sentTs != 0 && sentTs < ts)
				qDebug("Controller: Latency is %llums", ts - sentTs);
		}
		else if (type == "PARTICIPANT_SEARCH") {
			QVariantMap propertyMap = property.toMap();
			if (propertyMap["result"].toString() == "OK") {
				QList<QByteArray> ids;
				foreach (QVariant id, propertyMap["data"].toList())
					ids.append(id.toByteArray());
				this->collateParticipants(ids);
				emit q->participantSearchResults(this->m_lastSearchId, ids);
			}
			else if (propertyMap["result"].toString() == "TOO_SHORT")
				emit q->participantSearchResultsInvalid(this->m_lastSearchId, propertyMap["data"].toInt());
		}
		else if (type == "WAVELET_ADD_PARTICIPANT") {
			QVariantMap propertyMap = property.toMap();
			QByteArray pid = propertyMap["id"].toByteArray();
			QByteArray waveletId = propertyMap["waveletId"].toByteArray();
			this->collateParticipants(pid);
			Wavelet * wavelet = NULL;
			if (this->m_allWavelets.contains(waveletId))
				wavelet = this->m_allWavelets[waveletId];
			if (!wavelet) {
				if (pid == this->m_viewerId) { // Someone added me to a new wave, joy!
					QVariantMap prop;
					prop["waveId"] = propertyMap["waveId"];
					this->sendJson("manager", "WAVELET_LIST", prop); // Get the details
				}
			}
			else
				wavelet->addParticipant(this->m_allParticipants[pid]);
		}
		else if (type == "WAVELET_REMOVE_PARTICIPANT") {
			QVariantMap propertyMap = property.toMap();
			QByteArray pid = propertyMap["id"].toByteArray();
			QByteArray waveId = propertyMap["waveId"].toByteArray();
			QByteArray waveletId = propertyMap["waveletId"].toByteArray();
			if (this->m_allWavelets.contains(waveletId))
				this->m_allWavelets[waveletId]->removeParticipant(pid);
		}
		else if (type == "WAVELET_CREATED") {
			QVariantMap propertyMap = property.toMap();
			QByteArray waveId = propertyMap["waveId"].toByteArray();
			QByteArray waveletId = propertyMap["waveletId"].toByteArray();
			if (!this->m_allWaves.contains(waveId))
				this->m_createdWaveId = waveId;
			QVariantMap prop;
			prop["waveId"] = propertyMap["waveId"];
			this->sendJson("manager", "WAVELET_LIST", prop); // Reload wave
		}
		return;
	}

	// Wavelet messages
	Q_ASSERT(this->m_allWavelets.contains(waveletId));
	Wavelet * wavelet = this->m_allWavelets[waveletId];
	if (wavelet) {
		if (type == "WAVELET_OPEN") {
			QVariantMap propertyMap = property.toMap();
			QVariantMap blips = propertyMap["blips"].toMap();
			QVariantMap waveletMap = propertyMap["wavelet"].toMap();
			QByteArray rootBlipId = waveletMap["rootBlipId"].toByteArray();
			wavelet->loadBlipsFromSnapshot(blips, rootBlipId, this->m_allParticipants);
			emit q->waveletOpened(wavelet->id(), wavelet->isRoot());
		}
		else if (type == "OPERATION_MESSAGE_BUNDLE") {
			QVariantMap propertyMap = property.toMap();
			this->queueMessageBundle(wavelet, propertyMap["operations"], propertyMap["version"].toInt(), propertyMap["blipsums"].toMap());
		}
		else if (type == "OPERATION_MESSAGE_BUNDLE_ACK") {
			QVariantMap propertyMap = property.toMap();
			this->queueMessageBundle(wavelet, "ACK", propertyMap["version"].toInt(), propertyMap["blipsums"].toMap());
		}
		else if (type == "GADGET_LIST") {
		}
	}
}

void Controller::textInserted(const QByteArray &waveletId, const QByteArray &blipId, int index, const QString &content)
{
	P_D(Controller);
	Q_ASSERT(d->m_allWavelets.contains(waveletId));
	Wavelet * w = d->m_allWavelets[waveletId];
	Blip * b = w->blipById(blipId); Q_ASSERT(b);
	d->mcached[waveletId]->documentInsert(blipId, index, QString(content).replace("\n","\\n"));
	b->insertText(index, content, true);
}

void Controller::textDeleted(const QByteArray &waveletId, const QByteArray &blipId, int start, int end)
{
	P_D(Controller);
	Q_ASSERT(d->m_allWavelets.contains(waveletId));
	Wavelet * w = d->m_allWavelets[waveletId];
	Blip * b = w->blipById(blipId); Q_ASSERT(b);
	d->mcached[waveletId]->documentDelete(blipId, start, end);
	b->deleteText(start, end-start, true);
}

void Controller::elementDelete(const QByteArray &waveletId, const QByteArray &blipId, int index)
{
	P_D(Controller);
	Q_ASSERT(d->m_allWavelets.contains(waveletId));
	Wavelet * w = d->m_allWavelets[waveletId];
	Blip * b = w->blipById(blipId); Q_ASSERT(b);
	d->mcached[waveletId]->documentElementDelete(blipId, index);
	b->deleteElement(index, true);
}

void Controller::elementDeltaSubmitted(const QByteArray &waveletId, const QByteArray &blipId, int index, const QVariantMap &delta)
{
	P_D(Controller);
	Q_ASSERT(d->m_allWavelets.contains(waveletId));
	Wavelet * w = d->m_allWavelets[waveletId];
	Blip * b = w->blipById(blipId); Q_ASSERT(b);
	d->mcached[waveletId]->documentElementDelta(blipId, index, delta);
	b->applyElementDelta(index, delta);
}

void Controller::elementSetUserpref(const QByteArray &waveletId, const QByteArray &blipId, int index, const QString &key, const QString &value)
{
	P_D(Controller);
	Q_ASSERT(d->m_allWavelets.contains(waveletId));
	Wavelet * w = d->m_allWavelets[waveletId];
	Blip * b = w->blipById(blipId); Q_ASSERT(b);
	d->mcached[waveletId]->documentElementSetpref(blipId, index, key, value);
	b->setElementUserpref(index, key, value, true);
}

void ControllerPrivate::_q_mcached_afterOperationsInserted(int /*start*/, int /*end*/)
{
	P_Q(Controller);
	OpManager * mcached = qobject_cast<OpManager*>(q->sender());
	Q_ASSERT(mcached);
	QByteArray waveletId = mcached->waveletId();
	if (!this->hasPendingOperations(waveletId))
		this->transferOperations(waveletId);
}

void ControllerPrivate::_q_wavelet_participantsChanged()
{
	P_Q(Controller);
	Wavelet * wavelet = qobject_cast<Wavelet*>(q->sender());
	Q_ASSERT(wavelet);
	if (!wavelet->participant(this->m_viewerId)) { // I got kicked
		WaveModel * wave = wavelet->waveModel();
		if (wavelet == wave->rootWavelet()) // It was the root wavelet, oh no!
			this->removeWave(wave->id(), true);
		else { // Some other wavelet I was on, phew...
			QByteArray waveletId = wavelet->id();
			wave->removeWavelet(waveletId);
			this->m_allWavelets.remove(waveletId);
		}
	}
}

bool ControllerPrivate::hasPendingOperations(const QByteArray &waveletId)
{
	Q_ASSERT(this->ispending.contains(waveletId));
	return this->ispending[waveletId] || !this->mpending[waveletId]->isEmpty();
}

void ControllerPrivate::transferOperations(const QByteArray &waveletId)
{
	Q_ASSERT(this->mpending.contains(waveletId));
	OpManager * mp = this->mpending[waveletId];
	OpManager * mc = this->mcached[waveletId];
	Wavelet * model = this->m_allWavelets[waveletId];

	if (mp->isEmpty())
		mp->put(mc->fetch());

	//if (!this->isBlocked(waveletId)) {
	this->ispending[waveletId] = true;
	if (this->pendingTimer->isActive())
		this->pendingTimer->stop();
	this->pendingTimer->start();

	QVariantMap bundle;
	bundle["version"] = model->version();
	bundle["operations"] = mp->serialize();
	this->sendJson(waveletId, "OPERATION_MESSAGE_BUNDLE", bundle);
	//}
}

int Controller::searchForParticipant(const QString &text)
{
	P_D(Controller);
	d->sendJson("manager", "PARTICIPANT_SEARCH", text);
	return ++d->m_lastSearchId;
}

void ControllerPrivate::_q_pendingTimer_timeout()
{
	//TODO
}

void ControllerPrivate::queueMessageBundle(Wavelet * wavelet, const QVariant &serial_ops, int version, const QVariantMap &blipsums)
{
	//TODO
	this->processMessageBundle(wavelet, serial_ops, version, blipsums);
}

void ControllerPrivate::processMessageBundle(Wavelet * wavelet, const QVariant &serial_ops, int version, const QVariantMap &blipsums)
{
	OpManager * mpending = this->mpending[wavelet->id()];
	OpManager * mcached = this->mcached[wavelet->id()];

	if (serial_ops.type() == QVariant::List) {
		OpManager delta(wavelet->waveId(), wavelet->id());
		delta.unserialize(serial_ops.toList());

		QList<Operation*> ops;

		// Iterate over all operations
		foreach (Operation * incoming, delta.operations()) {
			// Transform pending operations, iterate over results
			foreach (Operation * tr, mpending->transform(incoming)) {
				// Transform cached operations, save results
				ops.append(mcached->transform(tr));
			}
		}

		// Check for new participants
		QList<QByteArray> newParticipants;
		foreach (Operation * op, ops) {
			if (op->type() == Operation::WAVELET_ADD_PARTICIPANT)
				newParticipants.append(op->property().toByteArray());
		}
		if (!newParticipants.isEmpty())
			this->collateParticipants(newParticipants);

		// Apply operations
		wavelet->applyOperations(ops, this->m_allParticipants);

		// Set version and checkup
		wavelet->setVersion(version);
		if (!this->hasPendingOperations(wavelet->id())) {
			QMap<QByteArray,QByteArray> blipsums_prep;
			foreach (QString key, blipsums.keys())
				blipsums_prep[key.toAscii()] = blipsums[key].toByteArray();
			wavelet->checkSync(blipsums_prep);
		}
	}
	else { // ACK message
		this->pendingTimer->stop();
		wavelet->setVersion(version);
		mpending->fetch(); // Clear
		if (!mcached->isEmpty())
			this->transferOperations(wavelet->id()); // Send cached
		else {
			// All done, we can do a check-up
			QMap<QByteArray,QByteArray> blipsums_prep;
			foreach (QString key, blipsums.keys())
				blipsums_prep[key.toAscii()] = blipsums[key].toByteArray();
			wavelet->checkSync(blipsums_prep);
			this->ispending[wavelet->id()] = false;
		}
	}
}


ControllerPrivate::ControllerPrivate(Controller * q) : pq_ptr(q) {}
