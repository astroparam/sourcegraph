package repoupdater

import (
	"context"

	"github.com/opentracing/opentracing-go/log"

	"github.com/sourcegraph/sourcegraph/internal/api"
	"github.com/sourcegraph/sourcegraph/internal/observation"
	"github.com/sourcegraph/sourcegraph/internal/repoupdater"
	"github.com/sourcegraph/sourcegraph/internal/repoupdater/protocol"
)

type Client struct {
	operations *operations
}

func New(observationContext *observation.Context) *Client {
	return &Client{
		operations: newOperations(observationContext),
	}
}

func (c *Client) RepoLookup(ctx context.Context, name api.RepoName) (_ *protocol.RepoInfo, err error) {
	ctx, endObservation := c.operations.repoLookup.With(ctx, &err, observation.Args{LogFields: []log.Field{
		log.String("repo", string(name)),
	}})
	defer endObservation(1, observation.Args{})

	result, err := repoupdater.DefaultClient.RepoLookup(ctx, protocol.RepoLookupArgs{Repo: name})
	if err != nil {
		return nil, err
	}

	return result.Repo, nil
}

func (c *Client) EnqueueRepoUpdate(ctx context.Context, repo api.RepoName) (_ *protocol.RepoUpdateResponse, err error) {
	ctx, endObservation := c.operations.enqueueRepoUpdate.With(ctx, &err, observation.Args{LogFields: []log.Field{
		log.String("repo", string(repo)),
	}})
	defer endObservation(1, observation.Args{})

	return repoupdater.DefaultClient.EnqueueRepoUpdate(ctx, repo)
}
