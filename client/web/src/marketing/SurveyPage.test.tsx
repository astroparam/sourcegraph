import { MockedResponse, MockedProviderProps } from '@apollo/client/testing'
import { cleanup, fireEvent, within, waitFor } from '@testing-library/react'
import { createMemoryHistory } from 'history'
import React from 'react'
import { Route } from 'react-router'

import { getDocumentNode } from '@sourcegraph/shared/src/graphql/apollo'
import { MockedTestProvider } from '@sourcegraph/shared/src/testing/apollo'
import { renderWithRouter, RenderWithRouterResult } from '@sourcegraph/shared/src/testing/render-with-router'

import { SubmitSurveyResult } from '../graphql-operations'

import { SUBMIT_SURVEY } from './SurveyForm'
import { SurveyPage } from './SurveyPage'

interface RenderSurveyPageParameters {
    mocks: MockedProviderProps['mocks']
    routerProps?: {
        matchParam?: string
        locationState?: {
            score: number
            feedback: string
        }
    }
}

describe('SurveyPage', () => {
    let renderResult: RenderWithRouterResult

    afterEach(cleanup)

    const renderSurveyPage = ({ mocks, routerProps }: RenderSurveyPageParameters) => {
        const history = createMemoryHistory()
        history.push(`/survey/${routerProps?.matchParam || ''}`, routerProps?.locationState)

        return renderWithRouter(
            <MockedTestProvider mocks={mocks}>
                <Route path="/survey/:score?">
                    <SurveyPage authenticatedUser={null} />
                </Route>
            </MockedTestProvider>,
            { route: '/', history }
        )
    }

    describe('Prior to submission', () => {
        const mockScore = 10
        const mockReason = 'I like it'
        const mockSuggestion = 'Read my mind'
        const submitSurveyMock: MockedResponse<SubmitSurveyResult> = {
            request: {
                query: getDocumentNode(SUBMIT_SURVEY),
                variables: {
                    input: {
                        score: mockScore,
                        email: '',
                        reason: mockReason,
                        better: mockSuggestion,
                    },
                },
            },
            result: {
                data: {
                    submitSurvey: {
                        alwaysNil: null,
                        __typename: 'EmptyResponse',
                    },
                },
            },
        }

        beforeEach(() => {
            renderResult = renderSurveyPage({ mocks: [submitSurveyMock] })
        })

        it('renders and handles form fields correctly', async () => {
            const recommendRadioGroup = renderResult.getByLabelText(
                'How likely is it that you would recommend Sourcegraph to a friend?'
            )
            expect(recommendRadioGroup).toBeVisible()
            const score10 = within(recommendRadioGroup).getByLabelText(mockScore)
            fireEvent.click(score10)

            const reasonInput = renderResult.getByLabelText(
                'What is the most important reason for the score you gave Sourcegraph?'
            )
            expect(reasonInput).toBeVisible()
            fireEvent.change(reasonInput, { target: { value: mockReason } })

            const betterProductInput = renderResult.getByLabelText(
                'What could Sourcegraph do to provide a better product?'
            )
            expect(betterProductInput).toBeVisible()
            fireEvent.change(betterProductInput, { target: { value: mockSuggestion } })

            fireEvent.click(renderResult.getByText('Submit'))

            await waitFor(() => expect(renderResult.history.location.pathname).toBe('/survey/thanks'))
        })
    })

    describe('After submission', () => {
        beforeEach(() => {
            renderResult = renderSurveyPage({
                mocks: [],
                routerProps: { matchParam: 'thanks', locationState: { score: 10, feedback: 'great' } },
            })
        })

        it('renders correct thank you message', () => {
            expect(renderResult.getByText('Thanks for the feedback!')).toBeVisible()
            expect(renderResult.getByText('Tweet feedback', { selector: 'a' })).toBeVisible()
        })
    })
})
