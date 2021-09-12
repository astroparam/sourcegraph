package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/cockroachdb/errors"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/sourcegraph/sourcegraph/internal/conf/conftypes"
	"github.com/sourcegraph/sourcegraph/internal/env"
	"github.com/sourcegraph/sourcegraph/internal/httpcli"
)

var frontendInternal = env.Get("SRC_FRONTEND_INTERNAL", "sourcegraph-frontend-internal", "HTTP address for internal frontend HTTP API.")

type internalClient struct {
	// URL is the root to the internal API frontend server.
	URL string
}

var InternalClient = &internalClient{URL: "http://" + frontendInternal}

var requestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name:    "src_frontend_internal_request_duration_seconds",
	Help:    "Time (in seconds) spent on request.",
	Buckets: prometheus.DefBuckets,
}, []string{"category", "code"})

type SavedQueryIDSpec struct {
	Subject SettingsSubject
	Key     string
}

// ConfigSavedQuery is the JSON shape of a saved query entry in the JSON configuration
// (i.e., an entry in the {"search.savedQueries": [...]} array).
type ConfigSavedQuery struct {
	Key             string  `json:"key,omitempty"`
	Description     string  `json:"description"`
	Query           string  `json:"query"`
	Notify          bool    `json:"notify,omitempty"`
	NotifySlack     bool    `json:"notifySlack,omitempty"`
	UserID          *int32  `json:"userID"`
	OrgID           *int32  `json:"orgID"`
	SlackWebhookURL *string `json:"slackWebhookURL"`
}

func (sq ConfigSavedQuery) Equals(other ConfigSavedQuery) bool {
	a, _ := json.Marshal(sq)
	b, _ := json.Marshal(other)
	return bytes.Equal(a, b)
}

// PartialConfigSavedQueries is the JSON configuration shape, including only the
// search.savedQueries section.
type PartialConfigSavedQueries struct {
	SavedQueries []ConfigSavedQuery `json:"search.savedQueries"`
}

// SavedQuerySpecAndConfig represents a saved query configuration its unique ID.
type SavedQuerySpecAndConfig struct {
	Spec   SavedQueryIDSpec
	Config ConfigSavedQuery
}

// SavedQueriesListAll lists all saved queries, from every user, org, etc.
func (c *internalClient) SavedQueriesListAll(ctx context.Context) (map[SavedQueryIDSpec]ConfigSavedQuery, error) {
	var result []SavedQuerySpecAndConfig
	err := c.postInternal(ctx, "saved-queries/list-all", nil, &result)
	if err != nil {
		return nil, err
	}
	m := map[SavedQueryIDSpec]ConfigSavedQuery{}
	for _, r := range result {
		m[r.Spec] = r.Config
	}
	return m, nil
}

// SavedQueryInfo represents information about a saved query that was executed.
type SavedQueryInfo struct {
	// Query is the search query in question.
	Query string

	// LastExecuted is the timestamp of the last time that the search query was
	// executed.
	LastExecuted time.Time

	// LatestResult is the timestamp of the latest-known result for the search
	// query. Therefore, searching `after:<LatestResult>` will return the new
	// search results not yet seen.
	LatestResult time.Time

	// ExecDuration is the amount of time it took for the query to execute.
	ExecDuration time.Duration
}

// SavedQueriesGetInfo gets the info from the DB for the given saved query. nil
// is returned if there is no existing info for the saved query.
func (c *internalClient) SavedQueriesGetInfo(ctx context.Context, query string) (*SavedQueryInfo, error) {
	var result *SavedQueryInfo
	err := c.postInternal(ctx, "saved-queries/get-info", query, &result)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// SavedQueriesSetInfo sets the info in the DB for the given query.
func (c *internalClient) SavedQueriesSetInfo(ctx context.Context, info *SavedQueryInfo) error {
	return c.postInternal(ctx, "saved-queries/set-info", info, nil)
}

// ReposListEnabled returns a list of all enabled repository names.
func (c *internalClient) ReposListEnabled(ctx context.Context) ([]RepoName, error) {
	var names []RepoName
	err := c.postInternal(ctx, "repos/list-enabled", nil, &names)
	return names, err
}

// MockInternalClientConfiguration mocks (*internalClient).Configuration.
var MockInternalClientConfiguration func() (conftypes.RawUnified, error)

func (c *internalClient) Configuration(ctx context.Context) (conftypes.RawUnified, error) {
	if MockInternalClientConfiguration != nil {
		return MockInternalClientConfiguration()
	}
	var cfg conftypes.RawUnified
	err := c.postInternal(ctx, "configuration", nil, &cfg)
	return cfg, err
}

func (c *internalClient) PhabricatorRepoCreate(ctx context.Context, repo RepoName, callsign, url string) error {
	return c.postInternal(ctx, "phabricator/repo-create", PhabricatorRepoCreateRequest{
		RepoName: repo,
		Callsign: callsign,
		URL:      url,
	}, nil)
}

var MockExternalServiceConfigs func(kind string, result interface{}) error

// TODO: This shouldn't exist.
// ExternalServiceConfigs fetches external service configs of a single kind into the result parameter,
// which should be a slice of the expected config type.
func (c *internalClient) ExternalServiceConfigs(ctx context.Context, kind string, result interface{}) error {
	if MockExternalServiceConfigs != nil {
		return MockExternalServiceConfigs(kind, result)
	}
	return c.postInternal(ctx, "external-services/configs", ExternalServiceConfigsRequest{
		Kind: kind,
	}, &result)
}

// postInternal sends an HTTP post request to the internal route.
func (c *internalClient) postInternal(ctx context.Context, route string, reqBody, respBody interface{}) error {
	return c.meteredPost(ctx, "/.internal/"+route, reqBody, respBody)
}

func (c *internalClient) meteredPost(ctx context.Context, route string, reqBody, respBody interface{}) error {
	start := time.Now()
	statusCode, err := c.post(ctx, route, reqBody, respBody)
	d := time.Since(start)

	code := strconv.Itoa(statusCode)
	if err != nil {
		code = "error"
	}
	requestDuration.WithLabelValues(route, code).Observe(d.Seconds())
	return err
}

// post sends an HTTP post request to the provided route. If reqBody is
// non-nil it will Marshal it as JSON and set that as the Request body. If
// respBody is non-nil the response body will be JSON unmarshalled to resp.
func (c *internalClient) post(ctx context.Context, route string, reqBody, respBody interface{}) (int, error) {
	var data []byte
	if reqBody != nil {
		var err error
		data, err = json.Marshal(reqBody)
		if err != nil {
			return -1, err
		}
	}

	req, err := http.NewRequest("POST", c.URL+route, bytes.NewBuffer(data))
	if err != nil {
		return -1, err
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := httpcli.InternalDoer.Do(req.WithContext(ctx))
	if err != nil {
		return -1, err
	}
	defer resp.Body.Close()
	if err := checkAPIResponse(resp); err != nil {
		return resp.StatusCode, err
	}

	if respBody != nil {
		return resp.StatusCode, json.NewDecoder(resp.Body).Decode(respBody)
	}
	return resp.StatusCode, nil
}

func checkAPIResponse(resp *http.Response) error {
	if 200 > resp.StatusCode || resp.StatusCode > 299 {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(resp.Body)
		b := buf.Bytes()
		errString := string(b)
		if errString != "" {
			return errors.Errorf(
				"internal API response error code %d: %s (%s)",
				resp.StatusCode,
				errString,
				resp.Request.URL,
			)
		}
		return errors.Errorf("internal API response error code %d (%s)", resp.StatusCode, resp.Request.URL)
	}
	return nil
}
