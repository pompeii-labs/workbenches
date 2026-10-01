import type { WorkbenchModelPolicy } from '../types.js';

export function modelLabel(model: WorkbenchModelPolicy): string {
    return model.id;
}
