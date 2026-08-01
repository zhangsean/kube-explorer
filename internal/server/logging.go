package server

import "github.com/sirupsen/logrus"

const normalSubscribeCloseMessage = "Error during subscribe websocket: close sent"

type normalSubscribeCloseFormatter struct {
	next logrus.Formatter
}

func (f *normalSubscribeCloseFormatter) Format(entry *logrus.Entry) ([]byte, error) {
	if entry.Message == normalSubscribeCloseMessage {
		return nil, nil
	}
	return f.next.Format(entry)
}

func installNormalSubscribeCloseHook() {
	logger := logrus.StandardLogger()
	if _, installed := logger.Formatter.(*normalSubscribeCloseFormatter); installed {
		return
	}
	logger.SetFormatter(&normalSubscribeCloseFormatter{next: logger.Formatter})
}
