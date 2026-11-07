import type { NormalizedRunnerInput } from '../session.js';

/** The stream-json user message whose uuid is the host command. */
export function userMessage(command: string, input: NormalizedRunnerInput) {
    return {
        type: 'user',
        uuid: command,
        session_id: '',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content:
                input.images.length > 0
                    ? [
                          ...input.images.map((image) => ({
                              type: 'image',
                              source: {
                                  type: 'base64',
                                  media_type: image.mimeType,
                                  data: image.data,
                              },
                          })),
                          { type: 'text', text: input.text },
                      ]
                    : input.text,
        },
    };
}
