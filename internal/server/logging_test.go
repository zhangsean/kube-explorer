package server

import (
	"bytes"
	"strings"
	"testing"

	"github.com/sirupsen/logrus"
)

func TestNormalSubscribeCloseFormatter(t *testing.T) {
	logger := logrus.New()
	var output bytes.Buffer
	logger.SetOutput(&output)
	logger.SetFormatter(&normalSubscribeCloseFormatter{next: &logrus.TextFormatter{DisableTimestamp: true}})

	logger.Error(normalSubscribeCloseMessage)
	if output.Len() != 0 {
		t.Fatalf("normal close log was not suppressed: %s", output.String())
	}

	logger.Error("Error during subscribe unexpected failure")
	if !strings.Contains(output.String(), "unexpected failure") {
		t.Fatalf("unexpected subscribe error was suppressed: %s", output.String())
	}
}
